// Each page's title, by the first part of its path. One list for the tab (main.ts) and for the HTML a search
// engine reads (vite.config.ts, pages()). Say what the page is in the words people search for.
export const HOME_TITLE = "wedgie: the open-source DIY Ethereum hardware wallet";
export const TITLES: Record<string, string> = {
  connect: "Connect your wedgie", assemble: "Assemble a wedgie: build your own hardware wallet", test: "Test a wedgie",
  update: "Update a wedgie's firmware", prepare: "Prepare", reset: "Reset a wedgie", batt: "Battery test", build: "Build your own wedgie",
  atomic: "Atomic wedgie", code: "Code: make apps for a wedgie", debug: "Debug",
  safe: "Safe hardware signer: sign a Safe multisig with a wedgie", secret: "Secret chat",
  order: "Order a wedgie hardware wallet", orders: "Your orders", signin: "Sign in", claim: "Free wedgie",
  terms: "Terms", privacy: "Privacy", sandbox: "Clear signing sandbox",
  virtual: "Virtual wedgie: try the hardware signer in your browser", emu: "Virtual wedgie", telegram: "Telegram",
};
