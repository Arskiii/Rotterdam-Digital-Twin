import { mountWorkspaceChrome } from "../ui/workspace";

export function mountIntelligenceChrome(root: HTMLElement) {
  mountWorkspaceChrome({ root, page: "intelligence", sections: [
    { id: "sources", label: "Observation quality", icon: "shield" },
    { id: "scenario", label: "Rain and bridge scenario", icon: "layers" },
    { id: "neighborhoods", label: "Neighborhood context", icon: "people" },
    { id: "proof", label: "Model checks", icon: "target" },
    { id: "api", label: "Open data", icon: "lock", breakBefore: true },
  ] });
}
