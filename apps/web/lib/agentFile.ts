// The agent file builder lives in @reputed/shared so the SDK builds the same file as the web form.
export {
  EMPTY_FIELDS,
  MAX_AGENT_URI_BYTES,
  MAX_DESCRIPTION,
  MAX_NAME,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  agentUriBytes,
  buildAgentFile,
  detailsComplete,
  endpointsComplete,
  isImageUrl,
  isLinkUrl,
  isValidPrice,
} from '@reputed/shared';
export type { AgentFields } from '@reputed/shared';
