import { VideoProjectDetailConsole } from "../../../../components/videos/video-project-detail-console";

export default async function VideoProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VideoProjectDetailConsole projectId={id} />;
}
