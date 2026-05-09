/**
 * Minimal ambient declaration for `imapflow`. The package ships no
 * `.d.ts` and there is no community `@types/imapflow`. We only
 * construct the class once at the factory boundary in `imap.ts` and
 * cast the instance through `unknown` to our own `ImapClientLike`
 * narrow shape — so the only thing TypeScript needs to know is that
 * `ImapFlow` is constructable.
 *
 * Upgrading to a richer set of types when imapflow ships them
 * upstream is a drop-in change: delete this file.
 */
declare module "imapflow" {
  export class ImapFlow {
    constructor(options: unknown);
  }
}
