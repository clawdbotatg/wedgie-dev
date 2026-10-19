// /terms and /privacy: who sells a wedgie and on what terms. Linked from the footer and the order page's
// pay box. The seller is BuidlGuidl DAO LLC (Stripe's support address). Plain words; the caps parts are caps
// on purpose (a warranty disclaimer has to stand out).
export const SELLER = "BuidlGuidl DAO LLC";
const ADDR = "3307 S College Ave Unit 104, Fort Collins, CO 80525";
const MAIL = "wedgie@buidlguidl.com";
const UPDATED = "October 17, 2026";

const TERMS = `
<h1>Terms of Sale</h1>
<p class="fine">Updated ${UPDATED}</p>
<p>wedgie.dev sells wedgies and wedgie kits. The seller is <b>${SELLER}</b> (a Wyoming LLC), ${ADDR} ("we"). Paying for an order means you agree to these terms.</p>

<h2>What you're buying</h2>
<p>A wedgie is a hobby computer made from off-the-shelf parts. The design, case, firmware, and this site are open source (MIT). A kit is the parts plus the instructions, for you to put together.</p>
<p>It's experimental. It's not a toy and it's not for kids under 14. It has small parts.</p>

<h2>Crypto and keys</h2>
<p>A wedgie can hold keys and sign transactions. It is <b>not an audited hardware wallet</b>. Software, firmware, and apps can have bugs. Don't keep more on it than you can afford to lose. Anyone holding your wedgie can use its key: if you lose it, remove it as an owner of anything it signs for.</p>
<p>We never see or keep your keys. We can't recover a lost key, a lost device, or lost funds, and we're not responsible for any transaction you sign.</p>

<h2>Price and payment</h2>
<p>The price moves with demand (shown on the order page). The price you see when you pay is the price you pay. Shipping is included. US only. Up to 3 per order.</p>
<p>Card payments go through Stripe. A USDC order gets its own address: send USDC (or ETH) there on Ethereum, Base, Arbitrum, or Optimism, in one send or several, until it adds up to the price. Only native USDC counts, not bridged USDC (USDC.e, USDbC). A full payment that arrives after the price ran out still counts. If you send too much, write to us and we'll send the extra back.</p>

<h2>Shipping</h2>
<p>We aim to ship within a week by USPS. If we can't, we'll email you and you can cancel for a full refund. If a package is lost, write to us and we'll help: file a claim or send another.</p>

<h2>Broken or dead on arrival</h2>
<p>If it arrives broken or doesn't work, write to ${MAIL} within 30 days of delivery. We'll replace it or refund you. That's our only promise about the hardware.</p>
<p>A kit is covered for missing or broken parts, not for damage while you put it together.</p>

<h2>Refunds and cancels</h2>
<p>Changed your mind before it ships? Write to us for a full refund. After it ships, we take back unused wedgies in their box within 30 days of delivery; you pay return shipping.</p>
<p>Card refunds go back to your card. USDC refunds go back as USDC, to an address you give us.</p>

<h2>No warranty</h2>
<p>EXCEPT FOR THE 30-DAY PROMISE ABOVE, WEDGIES, KITS, FIRMWARE, APPS, AND THIS SITE ARE PROVIDED "AS IS", WITH NO OTHER EXPRESS WARRANTY. ANY IMPLIED WARRANTY, INCLUDING MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE, LASTS ONLY 30 DAYS FROM DELIVERY. FIRMWARE, APPS, AND THIS SITE COME WITH NO WARRANTY OF ANY KIND. Some states don't allow this, so it may not all apply to you.</p>

<h2>Limit of liability</h2>
<p>TO THE EXTENT THE LAW ALLOWS, WE ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES, OR FOR LOST FUNDS, KEYS, DATA, OR PROFITS. OUR TOTAL LIABILITY FOR ANY ORDER IS AT MOST WHAT YOU PAID FOR IT. Some states don't allow this, so it may not all apply to you.</p>

<h2>Apps</h2>
<p>Apps on the shelf live in their own repos and may be written by other people. We check what we sign, but we don't promise any app works or is safe. Use them at your own risk.</p>

<h2>The rest</h2>
<p>Colorado law governs these terms. We may update them; the version on this page when you paid is the one that applies to your order.</p>
<p>Questions: <a href="mailto:${MAIL}">${MAIL}</a></p>`;

const PRIVACY = `
<h1>Privacy</h1>
<p class="fine">Updated ${UPDATED}</p>
<p>${SELLER} runs this site and the shop. We keep as little as we can.</p>

<h2>Your address</h2>
<p>Locked in your browser with a key only our shipping computer has. Our server, Stripe, and the blockchain never see your shipping address. We delete it once the box ships.</p>

<h2>Your email</h2>
<p>Used to send your sign-in link, your receipt, and your tracking number. The server keeps it locked (encrypted) with your order until the tracking email is sent, then deletes it; an order that's never paid keeps it until the order is deleted. While you're signed in, your sign-in keeps it locked too, until you sign out or 30 days pass. To find your orders it keeps a one-way hash of it. Our mailbox keeps copies of the emails we send you. We never sell or share your email.</p>

<h2>Payment</h2>
<p>Card payments are handled by Stripe, under <a href="https://stripe.com/privacy" target="_blank" rel="noopener">Stripe's privacy policy</a>. We never see your card number. Stripe may ask for a billing address; that stays with Stripe. USDC payments are public on the blockchain, like any transaction.</p>

<h2>Orders</h2>
<p>We keep what you ordered and its status. We delete an order 30 days after it ships or is canceled, or 30 days after it was made if it was never paid. An unpaid order that got some USDC is kept until it's sorted out with you.</p>

<h2>Your wedgie</h2>
<p>The site talks to a wedgie only after you tap Connect, and only in your browser. Nothing about your wedgie or its keys is sent to us.</p>

<h2>Cookies</h2>
<p>No ads, no trackers. Your browser stores your sign-in and your order links on your own computer. We count how many people reach each step of checkout, per day: just numbers, nothing about you. To stop abuse we keep a one-way hash of your IP address for a day (with a chat message, for its 7 days); never the address itself.</p>

<h2>Chat</h2>
<p>Messages sent with /secret are sealed on the wedgie: our server can't read them. It deletes each one after 7 days.</p>

<p>Questions or a request to delete: <a href="mailto:${MAIL}">${MAIL}</a></p>`;

export function legal(main: HTMLElement, which: "terms" | "privacy") {
  main.innerHTML = `<section class="test-page legal-page">
    <div class="band small" aria-hidden="true"><i></i><i></i><i></i></div>
    ${which === "terms" ? TERMS : PRIVACY}
  </section>`;
}
