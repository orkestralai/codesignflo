import { useEffect, useState } from "react";
import { Cart } from "./pages/Cart";
import { Home } from "./pages/Home";
import { Product } from "./pages/Product";

const route = () => window.location.hash.replace(/^#/, "") || "/";

export function App() {
  const [path, setPath] = useState(route());
  useEffect(() => {
    const on = () => setPath(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (path.startsWith("/product")) return <Product />;
  if (path.startsWith("/cart")) return <Cart />;
  return <Home />;
}
