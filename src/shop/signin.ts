// Whose sign-in link is this? (audit 11-13, SHOP-17) Signed in, this browser's orders with no email join the account.
// Someone could ask for a link to their own email and send it to you: your browser signed in as them and handed
// over your orders (then they got the shipped mail and its tracking number). So orders join by themselves only when
// this browser asked for that link, for that email, in the last 20 minutes. Any other link still signs in, and
// /orders asks first, naming the email. The server can't be fooled into it: only this page sends the orders' tokens.
export type Asked = { email: string; at: number } | null;
export const ASK_MS = 20 * 60000;      // a link lasts 15 minutes (api/login.ts)
/** This browser asked for a link to that email, lately. */
export function askedHere(asked: unknown, email: unknown, now: number): boolean {
  const a = asked as Asked;
  return !!a && typeof a.email === "string" && typeof email === "string" && !!email && a.email.trim().toLowerCase() === email.trim().toLowerCase()
    && typeof a.at === "number" && now - a.at >= 0 && now - a.at < ASK_MS;
}
/** The orders this browser holds that aren't on the signed-in email yet. */
export const notJoined = (local: string[], account: { id: string }[]) => local.filter((id) => !account.some((o) => o.id === id));
