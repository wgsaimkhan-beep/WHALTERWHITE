Add-Type -AssemblyName System.Drawing

$srcDir = "C:\Users\user\.gemini\antigravity-ide\brain\2a40e826-aeba-40dd-a160-c5d36ccd976d\.user_uploaded"
$darkSquarePath = Join-Path $srcDir "media_1792267900725.jpg"
$lightSquarePath = Join-Path $srcDir "media_1792267900781.jpg"
$darkTextTransparentPath = Join-Path $srcDir "media_1792267900814.png"
$whiteTextTransparentPath = Join-Path $srcDir "media_1792267900846.png"

Write-Host "Source dark square exists:" (Test-Path $darkSquarePath)
Write-Host "Source white transparent exists:" (Test-Path $whiteTextTransparentPath)

function Resize-Image {
    param(
        [string]$InputPath,
        [string]$OutputPath,
        [int]$Width,
        [int]$Height
    )
    $dir = Split-Path $OutputPath -Parent
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $src = [System.Drawing.Image]::FromFile($InputPath)
    $dest = New-Object System.Drawing.Bitmap($Width, $Height)
    $g = [System.Drawing.Graphics]::FromImage($dest)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $Width, $Height)
    $g.Dispose()
    $src.Dispose()

    $dest.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $dest.Dispose()
    Write-Host "Created: $OutputPath ($Width x $Height)"
}

# 1. Extension Icons (16, 32, 48, 128)
$extIconDir = "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\chrome-extension\icons"
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $extIconDir "icon16.png") -Width 16 -Height 16
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $extIconDir "icon32.png") -Width 32 -Height 32
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $extIconDir "icon48.png") -Width 48 -Height 48
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $extIconDir "icon128.png") -Width 128 -Height 128

# 2. Dist Extension Icons
$distIconDir = "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\dist\atomx-extension\icons"
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $distIconDir "icon16.png") -Width 16 -Height 16
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $distIconDir "icon32.png") -Width 32 -Height 32
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $distIconDir "icon48.png") -Width 48 -Height 48
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $distIconDir "icon128.png") -Width 128 -Height 128

# 3. TG Liker Icons
$tgLikerDir = "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\tg-liker"
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $tgLikerDir "icon16.png") -Width 16 -Height 16
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $tgLikerDir "icon48.png") -Width 48 -Height 48
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $tgLikerDir "icon128.png") -Width 128 -Height 128

# 4. Web Assets (Favicon, Logo, App Icons)
$assetsDir = "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\assets"
$backendAssetsDir = "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\backend\public\assets"

Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $assetsDir "icon.png") -Width 512 -Height 512
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $backendAssetsDir "icon.png") -Width 512 -Height 512

# Favicon PNGs
Resize-Image -InputPath $darkSquarePath -OutputPath "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\favicon.png" -Width 32 -Height 32
Resize-Image -InputPath $darkSquarePath -OutputPath "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\backend\public\favicon.png" -Width 32 -Height 32

# Transparent Logo Assets
Copy-Item $whiteTextTransparentPath -Destination (Join-Path $assetsDir "logo-dark.png") -Force
Copy-Item $whiteTextTransparentPath -Destination (Join-Path $backendAssetsDir "logo-dark.png") -Force
Copy-Item $darkTextTransparentPath -Destination (Join-Path $assetsDir "logo-light.png") -Force
Copy-Item $darkTextTransparentPath -Destination (Join-Path $backendAssetsDir "logo-light.png") -Force
Copy-Item $whiteTextTransparentPath -Destination (Join-Path $assetsDir "logo.png") -Force
Copy-Item $whiteTextTransparentPath -Destination (Join-Path $backendAssetsDir "logo.png") -Force

# Extension Assets
$extAssetsDir = "c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\chrome-extension\assets"
if (!(Test-Path $extAssetsDir)) { New-Item -ItemType Directory -Path $extAssetsDir -Force | Out-Null }
Copy-Item $whiteTextTransparentPath -Destination (Join-Path $extAssetsDir "logo-dark.png") -Force
Copy-Item $darkTextTransparentPath -Destination (Join-Path $extAssetsDir "logo-light.png") -Force
Copy-Item $whiteTextTransparentPath -Destination (Join-Path $extAssetsDir "logo.png") -Force
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $assetsDir "icon-dark.png") -Width 512 -Height 512
Resize-Image -InputPath $lightSquarePath -OutputPath (Join-Path $assetsDir "icon-light.png") -Width 512 -Height 512
Resize-Image -InputPath $darkSquarePath -OutputPath (Join-Path $backendAssetsDir "icon-dark.png") -Width 512 -Height 512
Resize-Image -InputPath $lightSquarePath -OutputPath (Join-Path $backendAssetsDir "icon-light.png") -Width 512 -Height 512
Copy-Item (Join-Path $assetsDir "icon-dark.png") -Destination (Join-Path $extAssetsDir "icon-dark.png") -Force
Copy-Item (Join-Path $assetsDir "icon-light.png") -Destination (Join-Path $extAssetsDir "icon-light.png") -Force
Copy-Item (Join-Path $extIconDir "icon128.png") -Destination (Join-Path $extAssetsDir "icon.png") -Force

# Generate .ico files
$favBmp = [System.Drawing.Bitmap]::FromFile("c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\favicon.png")
$hIcon = $favBmp.GetHicon()
$favIcon = [System.Drawing.Icon]::FromHandle($hIcon)

$icoStream1 = [System.IO.File]::Create("c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\favicon.ico")
$favIcon.Save($icoStream1)
$icoStream1.Dispose()

$icoStream2 = [System.IO.File]::Create("c:\Users\user\Documents\VsCode\Next.js\PlayGround\Twixor\backend\public\favicon.ico")
$favIcon.Save($icoStream2)
$icoStream2.Dispose()

$favIcon.Dispose()
$favBmp.Dispose()
Write-Host "Created: favicon.ico for root and backend/public"

Write-Host "✅ All icon and brand assets generated successfully!"
