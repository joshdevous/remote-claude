param(
    [string]$OutputPath,
    [string]$Monitor = "primary",  # "primary", "all", or monitor index (0, 1, 2...)
    [int]$WindowId = 0,  # Process ID of window to capture (0 = screen capture)
    [switch]$Grid,  # Overlay coordinate grid on screenshot
    [int]$GridSpacing = 200,  # Pixels between grid lines
    [int]$CropX = -1,  # Crop region X (screen coordinates)
    [int]$CropY = -1,  # Crop region Y (screen coordinates)
    [int]$CropW = 0,   # Crop region width
    [int]$CropH = 0    # Crop region height
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-ScreenBounds {
    param([string]$Monitor)

    $screens = [System.Windows.Forms.Screen]::AllScreens

    if ($Monitor -eq "all") {
        $left = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
        $top = ($screens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
        $right = ($screens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($screens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum

        return @{
            X = $left
            Y = $top
            Width = $right - $left
            Height = $bottom - $top
        }
    }
    elseif ($Monitor -eq "primary") {
        $primary = $screens | Where-Object { $_.Primary }
        return @{
            X = $primary.Bounds.X
            Y = $primary.Bounds.Y
            Width = $primary.Bounds.Width
            Height = $primary.Bounds.Height
        }
    }
    else {
        $index = [int]$Monitor
        if ($index -ge 0 -and $index -lt $screens.Count) {
            $screen = $screens[$index]
            return @{
                X = $screen.Bounds.X
                Y = $screen.Bounds.Y
                Width = $screen.Bounds.Width
                Height = $screen.Bounds.Height
            }
        }
        else {
            throw "Invalid monitor index: $index"
        }
    }
}

function Capture-Window {
    param([int]$ProcessId, [string]$OutputPath)

    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left, Top, Right, Bottom;
        }
    }
"@

    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
    $hwnd = $proc.MainWindowHandle

    if ($hwnd -eq [IntPtr]::Zero) {
        throw "Window not found for process $ProcessId"
    }

    # Use DWM extended frame bounds for accurate size (accounts for shadows/DPI)
    $rect = New-Object Win32+RECT
    $hr = [Win32]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
    if ($hr -ne 0) {
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    [Win32]::PrintWindow($hwnd, $hdc, 2) | Out-Null
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

function Capture-Screen {
    param($Bounds, [string]$OutputPath)

    $w = [int]$Bounds.Width
    $h = [int]$Bounds.Height
    $x = [int]$Bounds.X
    $y = [int]$Bounds.Y

    $bitmap = New-Object System.Drawing.Bitmap($w, $h)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $size = New-Object System.Drawing.Size($w, $h)
    $graphics.CopyFromScreen($x, $y, 0, 0, $size)

    # Draw cursor onto screenshot
    Add-Type -AssemblyName System.Windows.Forms
    $cursorPos = [System.Windows.Forms.Cursor]::Position
    $cursorX = $cursorPos.X - $x
    $cursorY = $cursorPos.Y - $y

    # Only draw if cursor is within this screen's bounds
    if ($cursorX -ge 0 -and $cursorX -lt $w -and $cursorY -ge 0 -and $cursorY -lt $h) {
        # Draw a visible crosshair + arrow shape at cursor position
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 255, 0), 3)
        $outlinePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 0, 0, 0), 5)
        # Crosshair lines (outline then fill for visibility on any background)
        $graphics.DrawLine($outlinePen, $cursorX - 15, $cursorY, $cursorX + 15, $cursorY)
        $graphics.DrawLine($outlinePen, $cursorX, $cursorY - 15, $cursorX, $cursorY + 15)
        $graphics.DrawLine($pen, $cursorX - 15, $cursorY, $cursorX + 15, $cursorY)
        $graphics.DrawLine($pen, $cursorX, $cursorY - 15, $cursorX, $cursorY + 15)
        # Center dot
        $graphics.FillEllipse([System.Drawing.Brushes]::Red, $cursorX - 3, $cursorY - 3, 6, 6)
        $pen.Dispose()
        $outlinePen.Dispose()
    }

    $graphics.Dispose()

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

function Crop-Image {
    param([string]$ImagePath, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$OriginX, [int]$OriginY)

    $img = [System.Drawing.Image]::FromFile($ImagePath)
    $cropLeft = [int]$X - [int]$OriginX
    $cropTop = [int]$Y - [int]$OriginY
    $srcRect = New-Object System.Drawing.Rectangle($cropLeft, $cropTop, [int]$W, [int]$H)

    # Clamp to image bounds
    if ($srcRect.X -lt 0) { $srcRect.Width += $srcRect.X; $srcRect.X = 0 }
    if ($srcRect.Y -lt 0) { $srcRect.Height += $srcRect.Y; $srcRect.Y = 0 }
    if ($srcRect.X + $srcRect.Width -gt $img.Width) { $srcRect.Width = $img.Width - $srcRect.X }
    if ($srcRect.Y + $srcRect.Height -gt $img.Height) { $srcRect.Height = $img.Height - $srcRect.Y }

    $cropped = New-Object System.Drawing.Bitmap($srcRect.Width, $srcRect.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($cropped)
    $destRect = New-Object System.Drawing.Rectangle(0, 0, $srcRect.Width, $srcRect.Height)
    $graphics.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.Dispose()
    $img.Dispose()

    $cropped.Save($ImagePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $cropped.Dispose()
}

function Add-Grid {
    param([string]$ImagePath, [int]$Spacing, [int]$OffsetX = 0, [int]$OffsetY = 0)

    $img = [System.Drawing.Image]::FromFile($ImagePath)
    $bitmap = New-Object System.Drawing.Bitmap($img)
    $img.Dispose()

    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(100, 255, 0, 0), 2)
    $font = New-Object System.Drawing.Font("Consolas", 28, [System.Drawing.FontStyle]::Bold)
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 100, 100))

    $w = $bitmap.Width
    $h = $bitmap.Height

    # Calculate first grid line position aligned to spacing from origin
    $startX = $Spacing - (($OffsetX) % $Spacing)
    if ($startX -eq $Spacing) { $startX = 0 }
    $startY = $Spacing - (($OffsetY) % $Spacing)
    if ($startY -eq $Spacing) { $startY = 0 }

    # Draw vertical lines with X labels (showing real screen coordinates)
    for ($x = $startX; $x -lt $w; $x += $Spacing) {
        $graphics.DrawLine($pen, $x, 0, $x, $h)
        $realX = $x + $OffsetX
        $label = "$realX"
        $size = $graphics.MeasureString($label, $font)
        $graphics.FillRectangle($bgBrush, $x + 2, 2, $size.Width + 6, $size.Height + 4)
        $graphics.DrawString($label, $font, $textBrush, ($x + 5), 4)
    }

    # Draw horizontal lines with Y labels (showing real screen coordinates)
    for ($y = $startY; $y -lt $h; $y += $Spacing) {
        $graphics.DrawLine($pen, 0, $y, $w, $y)
        $realY = $y + $OffsetY
        $label = "$realY"
        $size = $graphics.MeasureString($label, $font)
        $graphics.FillRectangle($bgBrush, 2, $y + 2, $size.Width + 6, $size.Height + 4)
        $graphics.DrawString($label, $font, $textBrush, 5, ($y + 4))
    }

    $graphics.Dispose()
    $pen.Dispose()
    $font.Dispose()
    $bgBrush.Dispose()
    $textBrush.Dispose()

    $bitmap.Save($ImagePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

# Main logic
try {
    # Determine screen origin for coordinate mapping
    $screenOriginX = 0
    $screenOriginY = 0

    if ($WindowId -gt 0) {
        Capture-Window -ProcessId $WindowId -OutputPath $OutputPath
    }
    else {
        $bounds = Get-ScreenBounds -Monitor $Monitor
        $screenOriginX = [int]$bounds.X
        $screenOriginY = [int]$bounds.Y
        Capture-Screen -Bounds $bounds -OutputPath $OutputPath
    }

    # Crop if requested
    if ($CropX -ge 0 -and $CropW -gt 0 -and $CropH -gt 0) {
        Crop-Image -ImagePath $OutputPath -X ([int]$CropX) -Y ([int]$CropY) -W ([int]$CropW) -H ([int]$CropH) -OriginX ([int]$screenOriginX) -OriginY ([int]$screenOriginY)
        # Grid labels should show real screen coordinates
        $gridOffsetX = [int]$CropX
        $gridOffsetY = [int]$CropY
    }
    else {
        $gridOffsetX = [int]$screenOriginX
        $gridOffsetY = [int]$screenOriginY
    }

    if ($Grid) {
        Add-Grid -ImagePath $OutputPath -Spacing $GridSpacing -OffsetX $gridOffsetX -OffsetY $gridOffsetY
    }

    Write-Output "OK"
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
