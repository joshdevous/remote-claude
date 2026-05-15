param(
    [int]$X,
    [int]$Y,
    [string]$Action = "move"  # "move", "click", "rightclick", "doubleclick"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class MouseHelper {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;

    public static void MoveTo(int x, int y) {
        SetCursorPos(x, y);
    }

    public static void LeftClick() {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void RightClick() {
        mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, IntPtr.Zero);
        mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void DoubleClick() {
        LeftClick();
        System.Threading.Thread.Sleep(50);
        LeftClick();
    }
}
"@

try {
    # Move cursor to position
    [MouseHelper]::MoveTo($X, $Y)

    # Small delay to ensure cursor is positioned
    Start-Sleep -Milliseconds 50

    switch ($Action) {
        "click"       { [MouseHelper]::LeftClick() }
        "rightclick"  { [MouseHelper]::RightClick() }
        "doubleclick" { [MouseHelper]::DoubleClick() }
        "move"        { } # Already moved
    }

    Write-Output "OK"
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
