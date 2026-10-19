"""Music Theory Engine. Plain Python, No Django here."""

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}

# key: (symbol, label, formula in semitones)

CHORD_QUALITIES = {
    "maj": ("", "Major", [0, 4, 7]),
    "min": ("m", "Minor", [0, 3, 7]),
    "dim": ("dim", "Diminished", [0, 3, 6]),
    "aug": ("aug", "Augmented", [0, 4, 8]),
    "7": ("7", "Dominant 7th", [0, 4, 7, 10]),
    "maj7": ("maj7", "Major 7th", [0, 4, 7, 11]),
    "m7": ("m7", "Minor 7th", [0, 3, 7, 10]),
    "sus2": ("sus2", "Suspended 2nd", [0, 2, 7]),
    "sus4": ("sus4", "Suspended 4th", [0, 5, 7]),
    "6":    ("6",    "Major 6th",     [0, 4, 7, 9]),
    "m6":   ("m6",   "Minor 6th",     [0, 3, 7, 9]),
    "dim7": ("dim7", "Diminished 7th", [0, 3, 6, 9]),
    "m7b5": ("m7b5", "Half-diminished 7th", [0, 3, 6, 10]),
    "5":     ("5",     "Power chord",        [0, 7]),
    "add9":  ("add9",  "Major add 9",        [0, 4, 7, 14]),
    "madd9": ("madd9", "Minor add 9",        [0, 3, 7, 14]),
    "69":    ("6/9",   "Six-nine",           [0, 4, 7, 9, 14]),
    "9":     ("9",     "Dominant 9th",       [0, 4, 7, 10, 14]),
    "maj9":  ("maj9",  "Major 9th",          [0, 4, 7, 11, 14]),
    "m9":    ("m9",    "Minor 9th",          [0, 3, 7, 10, 14]),
    "7sus4": ("7sus4", "Dominant 7 sus 4",   [0, 5, 7, 10]),
    "mmaj7": ("m(maj7)", "Minor-major 7th",  [0, 3, 7, 11]),
    "aug7":  ("7#5",   "Augmented 7th",      [0, 4, 8, 10]),
    "7b9":   ("7b9",   "Dominant 7 flat 9",  [0, 4, 7, 10, 13]),
    "7s9":   ("7#9",   "Dominant 7 sharp 9", [0, 4, 7, 10, 15]),
}

# what to call each shape: a triad has three notes, a seventh chord has four
CHORD_KINDS = {
    "maj": "Triad", "min": "Triad", "dim": "Triad", "aug": "Triad",
    "7": "Seventh chord", "maj7": "Seventh chord", "m7": "Seventh chord",
    "dim7": "Seventh chord", "m7b5": "Seventh chord",
    "sus2": "Suspended chord", "sus4": "Suspended chord",
    "6": "Sixth chord", "m6": "Sixth chord", "69": "Sixth chord",
    "5": "Power chord",
    "add9": "Added-note chord", "madd9": "Added-note chord",
    "9": "Ninth chord", "maj9": "Ninth chord", "m9": "Ninth chord",
    "7sus4": "Suspended chord", "mmaj7": "Seventh chord", "aug7": "Seventh chord",
    "7b9": "Altered dominant", "7s9": "Altered dominant",
}

SCALES = {
    "major": ("Major", [0, 2, 4, 5, 7, 9, 11]),
    "minor": ("Natural minor", [0, 2, 3, 5, 7, 8, 10]),
}

# the six "words": scale degree -> semitones above the key note
DEGREE_OFFSETS = {1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9}


class TheoryError(ValueError):
    """Raise when someone asks for a note or chord that doesn't exist."""


def spelling_for(name, key=False):
    """Which names to print notes with: flat names when the root was asked for with a flat.
    For a whole key (key=True), F major also reads better with flats (it has a B-flat)."""
    clean = name.strip().capitalize()
    if clean in FLAT_TO_SHARP or (key and clean == "F"):
        return FLAT_NAMES
    return SHARP_NAMES


def note_to_pc(name):
    """'C' -> 0, 'Bb' -> 10, 'f#' -> 6."""
    name = name.strip().capitalize()
    name = FLAT_TO_SHARP.get(name, name)
    if name not in SHARP_NAMES:
        raise TheoryError(f"Unknown note: {name!r}")
    return SHARP_NAMES.index(name)

def build_chord(root, quality="maj", octave=4):
    """Return the notes of a chord, plus MIDI numbers for the keyboard."""
    if quality not in CHORD_QUALITIES:
        raise TheoryError(f"Unknown chord type: {quality!r}")

    symbol, label, formula = CHORD_QUALITIES[quality]
    root_pc = note_to_pc(root)

    names = spelling_for(root)
    notes = [names[(root_pc + step) % 12] for step in formula]
    base = 12 * (octave + 1) + root_pc          # C4 = 60
    midi = [base + step for step in formula]

    return {
        "name": names[root_pc] + symbol,
        "label": f"{names[root_pc]} {label}",
        "notes": notes,
        "midi": midi
    }

def build_scale(root, scale="major", octave=4):
    if scale not in SCALES:
        raise TheoryError(f"Unknown scale: {scale!r}")
    label, steps = SCALES[scale]
    root_pc = note_to_pc(root)
    base = 12 * (octave + 1) + root_pc
    names = spelling_for(root, key=True)
    return {
        "name": f"{names[root_pc]} {label}",
        "notes": [names[(root_pc + s) % 12] for s in steps],
        "midi": [base + s for s in steps] + [base + 12],
    }

def parse_numeral(token):
    """'5' -> (5, 'maj'), '6m' -> (6, 'min')."""
    token = token.strip().lower()
    is_minor = token.endswith("m")
    digits = token[:-1] if is_minor else token
    if not digits.isdigit() or int(digits) not in DEGREE_OFFSETS:
        raise TheoryError(f"Unknown number: {token!r}. Use 1 to 6, like 1, 2m, 5.")
    return int(digits), ("min" if is_minor else "maj")

def build_progression(key, numerals, octave=4):
    key_pc = note_to_pc(key)
    tokens = [t for t in numerals.replace(",", "-").replace(" ", "-").split("-") if t]
    if not tokens:
        raise TheoryError("Give at least one number, like 1-5-6m-4")

    names = spelling_for(key, key=True)
    chords = []
    for token in tokens:
        degree, quality = parse_numeral(token)
        root_name = names[(key_pc + DEGREE_OFFSETS[degree]) % 12]
        chord = build_chord(root_name, quality, octave)
        chord["numeral"] = token
        chords.append(chord)
    return {"key": names[key_pc], "chords": chords}


INTERVAL_NAMES = {
    0: "Octave", 1: "Minor 2nd", 2: "Major 2nd", 3: "Minor 3rd", 4: "Major 3rd", 5: "Perfect 4th",
    6: "Tritone", 7: "Perfect 5th", 8: "Minor 6th", 9: "Major 6th", 10: "Minor 7th", 11: "Major 7th",
}

def identify_chord(midi_list):
    """Which chords contain exactly these notes? Root position is ranked first."""
    midi = sorted({int(m) for m in midi_list})
    if not midi:
        raise TheoryError("Pick at least one note.")
    bass = midi[0] % 12
    pcs = {m % 12 for m in midi}

    names = []
    for m in midi:
        name = SHARP_NAMES[m % 12]
        if name not in names:
            names.append(name)

    interval = None
    if len(midi) == 2:
        interval = INTERVAL_NAMES[(midi[1] - midi[0]) % 12]

    chords = []
    if len(pcs) >= 3:
        for root in range(12):
            if root not in pcs:
                continue
            shape = {(p - root) % 12 for p in pcs}
            for key, (symbol, label, formula) in CHORD_QUALITIES.items():
                if shape == {f % 12 for f in formula}:
                    name = SHARP_NAMES[root] + symbol
                    inverted = root != bass
                    if inverted:
                        name += "/" + SHARP_NAMES[bass]
                    chords.append({
                        "name": name,
                        "label": f"{SHARP_NAMES[root]} {label}",
                        "inversion": inverted,
                        "kind": CHORD_KINDS[key],
                    })
    chords.sort(key=lambda c: c["inversion"])
    return {"notes": names, "midi": midi, "interval": interval, "chords": chords}

# ---------- which key do these notes belong to? ----------
# major key note -> (name, sharps as a positive number or flats as a negative one)
MAJOR_KEYS = {
    0: ("C", 0), 7: ("G", 1), 2: ("D", 2), 9: ("A", 3), 4: ("E", 4), 11: ("B", 5),
    6: ("F#", 6), 1: ("Db", -5), 8: ("Ab", -4), 3: ("Eb", -3), 10: ("Bb", -2), 5: ("F", -1),
}
# the relative minor starts three semitones below its major key
MINOR_NAMES = {
    9: "A", 4: "E", 11: "B", 6: "F#", 1: "C#", 8: "G#", 3: "D#",
    10: "Bb", 5: "F", 0: "C", 7: "G", 2: "D",
}
SHARP_ORDER = ["F#", "C#", "G#", "D#", "A#", "E#", "B#"]
FLAT_ORDER = ["Bb", "Eb", "Ab", "Db", "Gb", "Cb", "Fb"]


def describe_signature(count):
    if count == 0:
        return "no sharps or flats"
    if count > 0:
        word, notes = "sharp", SHARP_ORDER[:count]
    else:
        word, notes = "flat", FLAT_ORDER[:-count]
    total = abs(count)
    return f"{total} {word}{'s' if total > 1 else ''}: " + ", ".join(notes)


def identify_key(midi_list):
    """Which major or natural minor keys contain every one of these notes?"""
    midi = sorted({int(m) for m in midi_list})
    if not midi:
        raise TheoryError("Play at least one note.")
    counts = {}
    for m in midi:
        counts[m % 12] = counts.get(m % 12, 0) + 1
    pcs = set(counts)
    bass = midi[0] % 12

    found = []
    for mode, (label, formula) in SCALES.items():
        for tonic in range(12):
            scale = {(tonic + step) % 12 for step in formula}
            if not pcs <= scale:
                continue
            major_pc = tonic if mode == "major" else (tonic + 3) % 12
            major_name, accidentals = MAJOR_KEYS[major_pc]
            tonic_name = major_name if mode == "major" else MINOR_NAMES[tonic]
            relative = (
                MINOR_NAMES[(tonic + 9) % 12] + " minor" if mode == "major"
                else MAJOR_KEYS[major_pc][0] + " major"
            )
            score = 2 * counts.get(tonic, 0) + counts.get((tonic + 7) % 12, 0) + (2 if tonic == bass else 0)
            found.append({
                "name": f"{tonic_name} {mode}",
                "signature": describe_signature(accidentals),
                "relative": relative,
                "accidentals": abs(accidentals),
                "score": score,
                "mode": mode,
            })
    found.sort(key=lambda k: (-k["score"], k["accidentals"], k["mode"] != "major"))
    notes = []
    for m in midi:
        name = SHARP_NAMES[m % 12]
        if name not in notes:
            notes.append(name)
    return {"notes": notes, "keys": found[:6]}
