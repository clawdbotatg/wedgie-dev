// Clear signing: the ERC-7730 bundle the wedgie's Safe Signer checks and shows, from /clear/<tag>/ (made by
// wire/release.py). One copy for wedgie.dev and Instant Wallet: clear-signing-safe-kit (src/clear.ts there).
import { clearBundle, clearFrom } from "clear-signing-safe-kit";

clearFrom("/clear/");
export { CLEAR_MAX } from "clear-signing-safe-kit";
export const bundle = clearBundle;
/** Where the files come from (tests: the disk). */
export const loadFrom = clearFrom;
