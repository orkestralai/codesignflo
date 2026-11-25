// CoDesignFlo's price, in one place: the web app (landing, docs, Billing), the server's Stripe Checkout and the
// agent's messages. A designer seat (the designer's own, used in every project) is €25 a month, VAT included;
// developers are free; every designer gets 5 free sends to dev before needing a seat.
// Launch offer: subscriptions started by the end of 15 December 2026 pay €15 a seat (VAT included) for their
// first 6 months (a Stripe coupon, 40% off, repeating for 6 months), then €25. After that date, checkout is
// plain €25 and the pages stop mentioning the offer by themselves.
// Prices include VAT (Stripe tax_behavior "inclusive"): Stripe Tax takes each customer's VAT out of the price,
// and businesses in the EU outside Germany with a VAT ID are invoiced the same amount without VAT (reverse
// charge). The German price rules (PAngV) want the total for consumers: these are totals.

export const SEAT_EUR = 25;
/** Sends to dev (Ready for dev, new designs) each designer gets for free, for good. */
export const FREE_SENDS = 5;
export const LAUNCH = {
  eur: 15,
  months: 6,
  percentOff: 40,
  /** The first moment the offer is over: 16 December 2026, 00:00 Italian time. */
  ends: "2026-12-16T00:00:00+01:00",
  until: "15 December",
  coupon: "launch_15_for_6_months",
} as const;

export const launchOn = (now = Date.now()) => now < Date.parse(LAUNCH.ends);

/** The seat's price in a sentence, with the launch offer while it runs. */
export function seatPrice(now = Date.now()): string {
  return launchOn(now)
    ? `€${LAUNCH.eur} a month per designer for the first ${LAUNCH.months} months if you subscribe by ${LAUNCH.until} (launch price), then €${SEAT_EUR}, VAT included`
    : `€${SEAT_EUR} a month per designer, VAT included`;
}

/** Under prices: how VAT works. */
export const VAT_NOTE =
  "Prices include VAT. Businesses in the EU outside Germany with a VAT ID are invoiced the same amount without VAT (reverse charge).";
