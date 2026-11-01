"""Recognize the fixed spectator HUD font using calibrated digit templates."""
from pathlib import Path
import cv2
import numpy as np


def glyphs(tile):
    ink = (tile < 128).astype(np.uint8)
    ink[:25] = 0
    ink[105:] = 0
    groups = []
    for x in np.where(ink.sum(axis=0) > 2)[0]:
        if not groups or x - groups[-1][-1] > 3:
            groups.append([x])
        else:
            groups[-1].append(x)
    result = []
    for group in groups:
        left, right = group[0], group[-1] + 1
        ys = np.where(ink[:, left:right].sum(axis=1) > 0)[0]
        if right - left < 8 or len(ys) == 0 or ys[-1] - ys[0] < 35:
            continue
        crop = ink[ys[0]:ys[-1]+1, left:right]
        result.append(cv2.resize(crop.astype(np.float32), (24, 48), interpolation=cv2.INTER_AREA))
    return result


class CounterReader:
    def __init__(self):
        with np.load(Path(__file__).parent/'assets'/'digit_templates.npz') as templates:
            self.values = templates['values']
            self.labels = templates['labels']

    def read(self, crop):
        tile = np.full((130, 180), 255, np.uint8)
        resized = cv2.resize(crop, (147, 99))
        _, tile[15:114, 15:162] = cv2.threshold(resized.min(axis=2), 180, 255, cv2.THRESH_BINARY_INV)
        digits = glyphs(tile)
        if not 1 <= len(digits) <= 3:
            return {}
        text, scores, margins = '', [], []
        for digit in digits:
            errors = np.mean(np.abs(self.values-digit), axis=(1, 2))
            per_label = np.array([errors[self.labels == n].min() for n in range(10)])
            order = np.argsort(per_label)
            best = order[0]
            text += str(best)
            scores.append(float(per_label[best]))
            margins.append(float(per_label[order[1]]-per_label[best]))
        if max(scores) < .24 and min(margins) > .015:
            return dict(count=int(text), similarity=round(1-max(scores), 4))
        return {}
