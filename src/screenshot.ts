import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const scriptsDir = path.join(__dirname, "..", "scripts");

export interface ScreenInfo {
  device: string;
  width: number;
  height: number;
  x: number;
  y: number;
  primary: boolean;
  index: number;
}

export interface WindowInfo {
  processName: string;
  title: string;
  id: number;
}

export async function getScreens(): Promise<ScreenInfo[]> {
  const script = path.join(scriptsDir, "get-screens.ps1");
  const output = await runPowerShell(script);
  const screens = JSON.parse(output);

  // Ensure it's always an array and add index
  const arr = Array.isArray(screens) ? screens : [screens];
  return arr.map((s: any, i: number) => ({
    device: s.Device,
    width: s.Width,
    height: s.Height,
    x: s.X,
    y: s.Y,
    primary: s.Primary,
    index: i,
  }));
}

export async function getWindows(): Promise<WindowInfo[]> {
  const script = path.join(scriptsDir, "get-windows.ps1");
  const output = await runPowerShell(script);
  const windows = JSON.parse(output);

  // Ensure it's always an array
  const arr = Array.isArray(windows) ? windows : [windows];
  return arr.map((w: any) => ({
    processName: w.ProcessName,
    title: w.Title,
    id: w.Id,
  }));
}

export interface ScreenshotOptions {
  monitor?: "primary" | "all" | number;  // Monitor selection
  windowId?: number;  // Process ID for window capture
  outputPath?: string;  // Custom output path
  grid?: boolean;  // Overlay coordinate grid
  gridSpacing?: number;  // Pixels between grid lines (default 200)
  crop?: { x: number; y: number; w: number; h: number };  // Crop to screen region
}

export async function takeScreenshot(options: ScreenshotOptions = {}): Promise<string> {
  const { monitor = "primary", windowId, outputPath, grid, gridSpacing, crop } = options;

  // Generate output path if not provided
  const tempDir = path.join(process.cwd(), ".temp-attachments");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `screenshot-${Date.now()}.png`;
  const filePath = outputPath || path.join(tempDir, filename);

  const script = path.join(scriptsDir, "take-screenshot.ps1");
  const args = ["-OutputPath", filePath];

  if (windowId) {
    args.push("-WindowId", windowId.toString());
  } else {
    args.push("-Monitor", monitor.toString());
  }

  if (grid) {
    args.push("-Grid");
    if (gridSpacing) {
      args.push("-GridSpacing", gridSpacing.toString());
    }
  }

  if (crop) {
    args.push("-CropX", crop.x.toString());
    args.push("-CropY", crop.y.toString());
    args.push("-CropW", crop.w.toString());
    args.push("-CropH", crop.h.toString());
  }

  await runPowerShell(script, args);

  return filePath;
}

// Parse natural language to determine screenshot target
export async function parseScreenshotRequest(text: string): Promise<ScreenshotOptions> {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  // Helper: check if a word exists as a whole word
  const hasWord = (word: string) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(lower);
  };

  // Helper: find number after a keyword
  const findNumberAfter = (keywords: string[]): number | null => {
    for (const kw of keywords) {
      const idx = words.indexOf(kw);
      if (idx !== -1 && idx + 1 < words.length) {
        const num = parseInt(words[idx + 1]);
        if (!isNaN(num)) return num - 1; // Convert to 0-indexed
      }
      // Also check "keyword 1" pattern
      const match = lower.match(new RegExp(`\\b${kw}\\s+(\\d+)\\b`));
      if (match) return parseInt(match[1]) - 1;
    }
    return null;
  };

  // Check for "all" requests - use word boundary
  if (hasWord("all") &&
      (hasWord("monitor") || hasWord("screen") || hasWord("display") ||
       hasWord("every"))) {
    return { monitor: "all" };
  }

  // Check for specific monitor number (supports "monitor 2", "screen 1", etc.)
  const monitorNum = findNumberAfter(["monitor", "screen", "display", "mon"]);
  if (monitorNum !== null) {
    return { monitor: monitorNum };
  }

  // Check for window/app capture with fuzzy matching
  const windows = await getWindows();
  let bestMatch: WindowInfo | null = null;
  let bestScore = 0;

  for (const win of windows) {
    const processLower = win.processName.toLowerCase();
    const titleLower = win.title.toLowerCase();
    const titleBase = titleLower.split(" - ")[0];

    // Exact word match scores highest
    if (hasWord(processLower)) {
      bestMatch = win;
      bestScore = 10;
      break;
    }

    // Check title base (e.g., "Visual Studio" from "Visual Studio - myfile.ts")
    const titleWords = titleBase.split(/\s+/);
    for (const titleWord of titleWords) {
      if (titleWord.length > 2 && hasWord(titleWord)) {
        if (bestScore < 5) {
          bestMatch = win;
          bestScore = 5;
        }
      }
    }

    // Partial match (substring) scores lower
    if (bestScore < 3 && lower.includes(processLower) && processLower.length > 3) {
      bestMatch = win;
      bestScore = 3;
    }
  }

  if (bestMatch && bestScore >= 3) {
    return { windowId: bestMatch.id };
  }

  // Check for positional words on multi-monitor setups
  const screens = await getScreens();
  if (screens.length > 1) {
    const sortedByX = [...screens].sort((a, b) => a.x - b.x);

    if (hasWord("left")) {
      return { monitor: sortedByX[0].index };
    }
    if (hasWord("right")) {
      return { monitor: sortedByX[sortedByX.length - 1].index };
    }
    if (hasWord("center") || hasWord("centre") || hasWord("middle")) {
      // Pick the middle screen
      const midIndex = Math.floor(sortedByX.length / 2);
      return { monitor: sortedByX[midIndex].index };
    }
  }

  // Default to primary
  return { monitor: "primary" };
}

async function runPowerShell(script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("powershell", [
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      ...args
    ]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `PowerShell exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

// Format screen/window info for display
export function formatScreenInfo(screens: ScreenInfo[]): string {
  const lines = screens.map((s, i) => {
    const primary = s.primary ? " (primary)" : "";
    return `${i}: ${s.width}x${s.height}${primary}`;
  });
  return lines.join("\n");
}

export function formatWindowInfo(windows: WindowInfo[]): string {
  const lines = windows.map((w) => `• ${w.processName}: ${w.title}`);
  return lines.join("\n");
}

// Check if text is asking for a list of windows/apps/screens
export function isListRequest(text: string): boolean {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  // Helper: check if a word exists as a whole word
  const hasWord = (word: string) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(lower);
  };

  // Direct list requests
  if (hasWord("list") &&
      (hasWord("window") || hasWord("app") || hasWord("program") ||
       hasWord("application") || hasWord("monitor") || hasWord("screen") || hasWord("display"))) {
    return true;
  }

  // "what/which windows/apps are open"
  if ((hasWord("what") || hasWord("which")) &&
      (hasWord("open") || hasWord("running")) &&
      (hasWord("window") || hasWord("app") || hasWord("program") || hasWord("application"))) {
    return true;
  }

  // "show me all windows/apps"
  if (hasWord("show") && hasWord("all") &&
      (hasWord("window") || hasWord("app") || hasWord("program") || hasWord("application"))) {
    return true;
  }

  // "what monitors do I have" / "show monitors"
  if ((hasWord("what") && hasWord("monitor")) ||
      (hasWord("what") && hasWord("screen")) ||
      (hasWord("show") && (hasWord("monitor") || hasWord("screen") || hasWord("display")))) {
    return true;
  }

  return false;
}
