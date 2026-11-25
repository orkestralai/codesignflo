// Example catalogue for the demo shop.
export type Product = { id: string; title: string; price: string; onSale: boolean; freeShipping?: boolean; description: string };

export const products: Product[] = [
  { id: "linen-shirt", title: "Linen shirt", price: "€49", onSale: true, freeShipping: true, description: "Light, breathable linen with a relaxed fit. Washes soft and gets better with every wear." },
  { id: "wool-scarf", title: "Wool scarf with a long name that wraps onto two lines", price: "€29", onSale: false, description: "Merino wool, finished by hand." },
  { id: "canvas-tote", title: "Canvas tote", price: "€19", onSale: false, freeShipping: true, description: "Heavy cotton canvas with inside pocket." },
];
