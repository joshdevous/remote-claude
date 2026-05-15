import { spawn } from "child_process";
import path from "path";

const scriptsDir = path.join(__dirname, "..", "scripts");

export type MouseAction = "move" | "click" | "rightclick" | "doubleclick";

export interface MouseOptions {
  x: number;
  y: number;
  action?: MouseAction;
}

export async function mouseControl(options: MouseOptions): Promise<void> {
  const { x, y, action = "move" } = options;
  const script = path.join(scriptsDir, "mouse-control.ps1");

  return new Promise((resolve, reject) => {
    const proc = spawn("powershell", [
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-X", x.toString(),
      "-Y", y.toString(),
      "-Action", action,
    ]);

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    proc.on("error", reject);
  });
}
