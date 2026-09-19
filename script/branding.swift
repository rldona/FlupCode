#!/usr/bin/env swift

// Regenerates every FlupCode raster brand asset from a single square PNG source.
//
//   swift script/branding.swift [source.png]
//
// Default source: assets/flupcode-tentative-logo.png
//
// The light "plate" shapes (rounded app icons, apple-touch, maskable, og) are
// reused from the current committed files so their geometry stays identical;
// the script only recolours the plate to #F5F5F5 and drops the new logo on top.
// Requires macOS (AppKit). No external tooling.

import AppKit

let DEVICE_RGB = CGColorSpaceCreateDeviceRGB()
let PLATE = CGColor(colorSpace: DEVICE_RGB, components: [245.0 / 255, 245.0 / 255, 245.0 / 255, 1])!

enum Basis {
    case width
    case height
}

struct Target {
    let path: String
    let width: Int
    let height: Int
    let plate: Bool
    let fraction: Double
    let basis: Basis
    var background: CGColor = PLATE
    // Fraction of the canvas the artwork occupies. macOS app icons sit inside
    // the system grid (~80%), so they need padding; web/og icons bleed to the edge.
    var scale: Double = 1
    // Read the plate shape from another file so a padded output does not feed
    // back into the next run. Defaults to the target itself.
    var frame: String? = nil
}

let targets: [Target] = [
    Target(path: "packages/harness-desktop/build/icon.png", width: 1024, height: 1024, plate: true, fraction: 0.700, basis: .width),
    Target(path: "packages/harness-desktop/build/icon-mac.png", width: 1024, height: 1024, plate: true, fraction: 0.650, basis: .width, scale: 0.805, frame: "packages/harness-desktop/build/icon.png"),
    Target(path: "packages/harness/public/apple-touch-icon.png", width: 180, height: 180, plate: true, fraction: 0.722, basis: .width),
    Target(path: "packages/harness/public/icon-192.png", width: 192, height: 192, plate: true, fraction: 0.698, basis: .width),
    Target(path: "packages/harness/public/icon-512.png", width: 512, height: 512, plate: true, fraction: 0.700, basis: .width),
    Target(path: "packages/harness/public/icon-maskable-512.png", width: 512, height: 512, plate: true, fraction: 0.555, basis: .width),
    Target(path: "packages/harness/src/assets/flupcode-logo.png", width: 256, height: 256, plate: false, fraction: 0.900, basis: .width),
    Target(path: "packages/landing/assets/apple-touch-icon.png", width: 180, height: 180, plate: true, fraction: 0.722, basis: .width),
    Target(path: "packages/landing/assets/flupcode-logo.png", width: 320, height: 320, plate: false, fraction: 0.900, basis: .width),
    Target(path: "packages/landing/assets/icon-192.png", width: 192, height: 192, plate: true, fraction: 0.698, basis: .width),
    Target(path: "packages/landing/assets/og.png", width: 1200, height: 630, plate: true, fraction: 0.800, basis: .height),
]

func loadCGImage(_ path: String) -> CGImage? {
    guard let image = NSImage(contentsOfFile: path) else { return nil }
    return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
}

func context(_ width: Int, _ height: Int) -> CGContext? {
    CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: DEVICE_RGB,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
    )
}

// Alpha bounding box in top-left coordinates (matches CGImage.cropping).
func alphaBounds(_ cg: CGImage, threshold: UInt8 = 8) -> CGRect {
    let w = cg.width
    let h = cg.height
    guard let ctx = context(w, h) else { return CGRect(x: 0, y: 0, width: w, height: h) }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    let data = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h {
        for x in 0..<w {
            if data[(y * w + x) * 4 + 3] > threshold {
                if x < minX { minX = x }
                if x > maxX { maxX = x }
                if y < minY { minY = y }
                if y > maxY { maxY = y }
            }
        }
    }
    if maxX < 0 { return CGRect(x: 0, y: 0, width: w, height: h) }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

func writePNG(_ ctx: CGContext, to path: String) throws {
    guard let cg = ctx.makeImage() else { throw NSError(domain: "branding", code: 1) }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "branding", code: 2)
    }
    try data.write(to: URL(fileURLWithPath: path))
}

func generate(source: CGImage, bounds: CGRect, target: Target) throws {
    let w = target.width
    let h = target.height
    guard let ctx = context(w, h) else { throw NSError(domain: "branding", code: 3) }
    ctx.interpolationQuality = .high

    let plateWidth = Double(w) * target.scale
    let plateHeight = Double(h) * target.scale
    let plateX = (Double(w) - plateWidth) / 2
    let plateY = (Double(h) - plateHeight) / 2

    if target.plate {
        let framePath = target.frame ?? target.path
        guard let frame = loadCGImage(framePath) else {
            throw NSError(domain: "branding", code: 4, userInfo: [NSLocalizedDescriptionKey: "missing plate frame: \(framePath)"])
        }
        ctx.draw(frame, in: CGRect(x: plateX, y: plateY, width: plateWidth, height: plateHeight))
        ctx.setBlendMode(.sourceIn)
        ctx.setFillColor(target.background)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setBlendMode(.normal)
    }

    // Transparent artwork must fit inside the canvas on both axes; scaling by
    // a single basis overflows when the art isn't square (e.g. a portrait
    // logo scaled by width gets cropped top and bottom).
    let drawWidth: Double
    let drawHeight: Double
    if target.plate {
        let base = (target.basis == .width ? Double(w) : Double(h)) * target.scale * target.fraction
        let aspect = bounds.width / bounds.height
        drawWidth = target.basis == .width ? base : base * Double(aspect)
        drawHeight = target.basis == .width ? base / Double(aspect) : base
    } else {
        let fit =
            min(Double(w) / bounds.width, Double(h) / bounds.height) * target.fraction
        drawWidth = bounds.width * fit
        drawHeight = bounds.height * fit
    }
    let x = (Double(w) - drawWidth) / 2
    let y = (Double(h) - drawHeight) / 2

    let logo = source.cropping(to: bounds)!
    ctx.draw(logo, in: CGRect(x: x, y: y, width: drawWidth, height: drawHeight))
    try writePNG(ctx, to: target.path)
    print("  \(target.path)  \(w)x\(h)  logo \(Int(drawWidth))x\(Int(drawHeight))")
}

let sourcePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/flupcode-tentative-logo.png"
guard let source = loadCGImage(sourcePath) else {
    FileHandle.standardError.write("Cannot read source: \(sourcePath)\n".data(using: .utf8)!)
    exit(1)
}

let bounds = alphaBounds(source)
print("source \(sourcePath) \(source.width)x\(source.height) content \(Int(bounds.width))x\(Int(bounds.height))")

for target in targets {
    do {
        try generate(source: source, bounds: bounds, target: target)
    } catch {
        FileHandle.standardError.write("FAILED \(target.path): \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}
print("done")
