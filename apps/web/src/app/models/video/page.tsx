import { AgentBindingCenter } from "../../../components/models/agent-binding-center";
import { ModelCenterErrorState } from "../../../components/models/model-center-error-state";
import { getModelCenterConfig } from "../../../lib/api";

export default async function VideoModelBindingsPage() {
  try {
    const modelCenter = await getModelCenterConfig();
    return <AgentBindingCenter initialModelCenter={modelCenter} group="video" />;
  } catch (error) {
    return <ModelCenterErrorState message={error instanceof Error ? error.message : "Unknown model-center error."} />;
  }
}
