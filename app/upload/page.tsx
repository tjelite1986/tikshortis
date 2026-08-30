import ShortsUpload from "@/components/shorts-upload";

export const dynamic = "force-dynamic";

// There is one channel, so the picker is locked rather than offered.
export default function ShortsUploadPage() {
  return <ShortsUpload defaultChannel="main" lockChannel />;
}
