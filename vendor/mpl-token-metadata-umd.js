/* esm.sh - @metaplex-foundation/mpl-token-metadata@3.4.0 */
import "/@metaplex-foundation/umi@^1.2.0/serializers?target=es2020";
import "/@metaplex-foundation/umi@^1.2.0?target=es2020";
export * from "/@metaplex-foundation/mpl-token-metadata@3.4.0/es2020/mpl-token-metadata.bundle.mjs";
export { default } from "/@metaplex-foundation/mpl-token-metadata@3.4.0/es2020/mpl-token-metadata.bundle.mjs";

/* KV-SHIM for mpl-token-metadata: import ESM and attach globals */
import * as TM from "https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.4.0?bundle&target=es2020";
window.mpl_token_metadata = TM;
window.mplTokenMetadata   = TM;
window.metaplex = window.metaplex || {};
window.metaplex.mplTokenMetadata = TM;

// Fallback in case PROGRAM_ID missing
if (!TM.PROGRAM_ID) {
  window.mpl_token_metadata.PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
}