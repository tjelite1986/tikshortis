/**
 * Account management — there is no sign-up page, so this is how accounts are
 * made.
 *
 * Runs inside the container, where better-sqlite3 is built for the right
 * glibc. The script travels on stdin, so nothing has to be mounted:
 *
 *   docker exec -i tikshortis node - list                     < scripts/users.cjs
 *   docker exec -i -e PASSWORD=… tikshortis node - add <email> [admin] < scripts/users.cjs
 *   docker exec -i -e PASSWORD=… tikshortis node - passwd <email>      < scripts/users.cjs
 *   docker exec -i tikshortis node - role <email> <user|admin>         < scripts/users.cjs
 *   docker exec -i tikshortis node - remove <email>                    < scripts/users.cjs
 *   docker exec -i -e USERS_JSON='[…]' tikshortis node - import        < scripts/users.cjs
 *
 * Passwords come from the environment, never the argument list, which any
 * process on the host can read. `import` takes `[{ id, email, password_hash }]`
 * with scrypt hashes in the format of lib/password.ts and sets the hash on the
 * row with that id — the ids are the ones every like, upload and playlist is
 * already keyed on. The email must match, so a hash cannot land on the wrong
 * person when two databases have drifted apart.
 *
 * The tables are created by lib/db.ts; run this after the app has started once.
 */
const path = require("node:path");
const { randomBytes, scryptSync } = require("node:crypto");
const Database = require("better-sqlite3");

const DB_PATH = path.join(
  process.env.DATA_DIR || path.join(process.cwd(), "data"),
  "tikshortis.db"
);

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function password() {
  const value = process.env.PASSWORD;
  if (!value || value.length < 8) fail("Set PASSWORD (at least 8 characters)");
  return value;
}

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!columns.includes("password_hash")) {
  fail("The users table has no password_hash yet — start the app once first");
}

function find(email) {
  return db
    .prepare("SELECT id, email, role FROM users WHERE email = ? COLLATE NOCASE")
    .get(email);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list": {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.role, u.username,
                u.password_hash IS NOT NULL AS can_sign_in,
                (SELECT COUNT(*) FROM sessions s
                  WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
           FROM users u ORDER BY u.id`
      )
      .all(new Date().toISOString());
    console.table(rows);
    break;
  }
  case "add": {
    const [email, role = "user"] = args;
    if (!email || !email.includes("@")) fail("Usage: add <email> [admin]");
    if (role !== "user" && role !== "admin") fail("Role is user or admin");
    if (find(email)) fail(`${email} already exists`);
    const hash = hashPassword(password());
    const info = db
      .prepare(
        "INSERT INTO users (email, role, username, password_hash) VALUES (?, ?, ?, ?)"
      )
      .run(email, role, email.split("@")[0], hash);
    console.log(`Added ${email} (${role}) as id ${info.lastInsertRowid}`);
    break;
  }
  case "passwd": {
    const [email] = args;
    const user = email && find(email);
    if (!user) fail(`No account ${email ?? ""}`);
    const hash = hashPassword(password());
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
      // A new password ends every session the old one opened.
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    })();
    console.log(`Password changed for ${user.email}; its sessions were ended`);
    break;
  }
  case "role": {
    const [email, role] = args;
    const user = email && find(email);
    if (!user) fail(`No account ${email ?? ""}`);
    if (role !== "user" && role !== "admin") fail("Role is user or admin");
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, user.id);
    console.log(`${user.email} is now ${role}`);
    break;
  }
  case "remove": {
    const [email] = args;
    const user = email && find(email);
    if (!user) fail(`No account ${email ?? ""}`);
    // The row stays: likes, uploads and playlists are keyed on its id, and a
    // deleted account would leave them pointing at nobody. Taking the password
    // away and ending its sessions is what stops it signing in.
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").run(user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    })();
    console.log(`${user.email} can no longer sign in`);
    break;
  }
  case "import": {
    let list;
    try {
      list = JSON.parse(process.env.USERS_JSON || "");
    } catch {
      fail("Set USERS_JSON to a JSON array");
    }
    if (!Array.isArray(list)) fail("USERS_JSON must be an array");
    const byId = db.prepare("SELECT id, email FROM users WHERE id = ?");
    const set = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
    let done = 0;
    db.transaction(() => {
      for (const entry of list) {
        const row = byId.get(entry.id);
        if (!row) {
          console.log(`skip id ${entry.id}: no such account here`);
          continue;
        }
        if (row.email.toLowerCase() !== String(entry.email).toLowerCase()) {
          console.log(`skip id ${entry.id}: email differs (${row.email} here)`);
          continue;
        }
        if (typeof entry.password_hash !== "string" || !entry.password_hash.includes(":")) {
          console.log(`skip id ${entry.id}: no usable password_hash`);
          continue;
        }
        set.run(entry.password_hash, row.id);
        done++;
      }
    })();
    console.log(`Imported ${done} of ${list.length}`);
    break;
  }
  default:
    fail("Commands: list | add <email> [admin] | passwd <email> | role <email> <user|admin> | remove <email> | import");
}
