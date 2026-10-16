# gif.py <gifs.json>: turns the frames `bun run mod preview --gifs` screenshots into animated GIFs.
# Each entry is [frames dir, output path, ms per frame]; a dir with boxes.json holds one tall
# screenshot (all.png) to cut into frames, otherwise numbered PNGs. Needs Pillow.
import json, sys, os, glob
from PIL import Image
for d, outp, ms in json.load(open(sys.argv[1])):
    boxes = os.path.join(d, 'boxes.json')
    if os.path.exists(boxes):
        full = Image.open(os.path.join(d, 'all.png')).convert('RGB')
        ims = [full.crop((int(x), int(y), int(x + w), int(y + h))) for x, y, w, h in json.load(open(boxes))]
    else:
        ims = [Image.open(f).convert('RGB') for f in sorted(glob.glob(os.path.join(d, '*.png')))]
    if not ims: continue
    w = max(i.width for i in ims); h = max(i.height for i in ims)
    ims = [i if i.size == (w, h) else i.resize((w, h)) for i in ims]
    pal = [i.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for i in ims]
    pal[0].save(outp, save_all=True, append_images=pal[1:], duration=ms, loop=0, optimize=False, disposal=2)
    print('gif', os.path.basename(outp), len(ims))
