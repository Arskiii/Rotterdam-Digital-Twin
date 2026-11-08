import { createLiveHandler } from "../server/live-endpoint.mjs";
import { archiveLiveSource } from "../server/archive-live-source.mjs";

export default createLiveHandler({ collect: archiveLiveSource() });
