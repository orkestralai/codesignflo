import { Bridge, type BridgeOptions, type Session } from "../bridge/server.js";
import { printable } from "../safe.js";

/** Starts the bridge, waits for the plugin in the right file, runs `fn`, and always closes. */
export async function withPlugin<T>(
  accept: BridgeOptions["accept"],
  fn: (s: Session) => Promise<T>,
  opts: { projectId?: string } = {},
): Promise<T> {
  const bridge = new Bridge({ accept, ...opts });
  await bridge.listen();
  console.error("waiting for the CoDesignFlo plugin in Figma desktop…");
  try {
    // CODESIGNFLO_WAIT_S: how long to wait for the plugin (skills use a short wait and tell the user).
    const s = await bridge.waitForPlugin(Number(process.env.CODESIGNFLO_WAIT_S ?? process.env.CODESIGNLOOP_WAIT_S ?? 120) * 1000);
    console.error(`connected to "${printable(s.hello.file.name)}" (plugin ${printable(s.hello.plugin.version, 20)})`);
    return await fn(s);
  } finally {
    await bridge.close();
  }
}
