
import { Jimp } from "jimp";

async function main() {
    const image = await Jimp.read("public/icon.png");

    // Get color at 0,0 (top-left corner) to determine background color
    const idx0 = 0;
    const bgR = image.bitmap.data[idx0 + 0];
    const bgG = image.bitmap.data[idx0 + 1];
    const bgB = image.bitmap.data[idx0 + 2];

    console.log(`Detected background color: R=${bgR}, G=${bgG}, B=${bgB}`);

    const threshold = 40; // Increased tolerance for artifacts

    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
        const r = this.bitmap.data[idx + 0];
        const g = this.bitmap.data[idx + 1];
        const b = this.bitmap.data[idx + 2];

        // Check if pixel matches background color
        if (Math.abs(r - bgR) < threshold &&
            Math.abs(g - bgG) < threshold &&
            Math.abs(b - bgB) < threshold) {
            // Set alpha to 0 (transparent)
            this.bitmap.data[idx + 3] = 0;
        }
    });

    // Auto-crop to remove transparency around the object
    image.autocrop();

    // Resize to standard icon size (e.g., 512x512) to ensure it's not "small"
    // New Jimp API expects object arguments
    image.contain({ w: 512, h: 512 });

    await image.write("public/icon-transparent.png");
    console.log("Transformed image saved to public/icon-transparent.png");
}

main().catch(console.error);
