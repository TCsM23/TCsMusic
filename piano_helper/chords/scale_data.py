"""Every scale the site knows, in one place.

The Scales page and the Studio's scale picker both read this, so they cannot disagree.
A scale is a list of semitones above its root (0 is the root). Everything else (the
whole-step / half-step pattern, how many different keys it has) is worked out from that list.
"""

STEP_NAMES = {1: "H", 2: "W", 3: "W+H"}  # half step, whole step, and the leap of a step and a half


def _pattern(steps):
    """W-W-H-W-W-W-H style text, including the step back up to the root."""
    gaps = [b - a for a, b in zip(steps, steps[1:] + [12])]
    return "-".join(STEP_NAMES.get(g, str(g)) for g in gaps)


def _transpositions(steps):
    """How many different keys the scale has: a whole-tone scale only has two."""
    notes = set(steps)
    same = sum(1 for shift in range(12) if {(s + shift) % 12 for s in steps} == notes)
    return 12 // same


# id, name, steps, descending steps (if they differ), character, mode of (for the church modes)
_SCALES = [
    # ---- major and diatonic ----
    ("diatonic", "major", "Major", [0, 2, 4, 5, 7, 9, 11], None,
     "Bright, stable and resolved. The scale most Western tunes are built on, and the one the others are measured against."),
    ("diatonic", "natural-minor", "Natural minor", [0, 2, 3, 5, 7, 8, 10], None,
     "Darker and more inward than the major scale. The same notes as its relative major, started from the sixth."),
    ("diatonic", "harmonic-minor", "Harmonic minor", [0, 2, 3, 5, 7, 8, 11], None,
     "Natural minor with the seventh raised a half step. That leading tone pulls hard back to the tonic, and leaves a step and a half between the sixth and seventh."),
    ("diatonic", "melodic-minor", "Melodic minor", [0, 2, 3, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10],
     "Raises the sixth and seventh going up, for a smooth line, and falls back to natural minor coming down."),
    # ---- pentatonic and blues ----
    ("pentatonic", "major-pentatonic", "Major pentatonic", [0, 2, 4, 7, 9], None,
     "The major scale without its fourth and seventh. Open and uplifting, and almost impossible to play a wrong note in."),
    ("pentatonic", "minor-pentatonic", "Minor pentatonic", [0, 3, 5, 7, 10], None,
     "The natural minor scale without its second and sixth. The backbone of rock, blues and a lot of pop."),
    ("pentatonic", "blues", "Blues", [0, 3, 5, 6, 7, 10], None,
     "The minor pentatonic with a flattened fifth added: the blue note, a small, gritty tension that wants to move."),
    # ---- the church modes ----
    ("modes", "ionian", "Ionian", [0, 2, 4, 5, 7, 9, 11], None,
     "The major scale itself. Bright and settled.", 1),
    ("modes", "dorian", "Dorian", [0, 2, 3, 5, 7, 9, 10], None,
     "Natural minor with a raised sixth. Minor, but lifted and a little hopeful.", 2),
    ("modes", "phrygian", "Phrygian", [0, 1, 3, 5, 7, 8, 10], None,
     "Natural minor with a lowered second. Dark and tense, with a Spanish edge.", 3),
    ("modes", "lydian", "Lydian", [0, 2, 4, 6, 7, 9, 11], None,
     "A major scale with a raised fourth. Dreamy and floating, the brightest of the modes.", 4),
    ("modes", "mixolydian", "Mixolydian", [0, 2, 4, 5, 7, 9, 10], None,
     "A major scale with a lowered seventh. Relaxed and bluesy, the sound of a lot of rock.", 5),
    ("modes", "aeolian", "Aeolian", [0, 2, 3, 5, 7, 8, 10], None,
     "The natural minor scale itself.", 6),
    ("modes", "locrian", "Locrian", [0, 1, 3, 5, 6, 8, 10], None,
     "The unstable one: its fifth is flattened, so the tonic chord is diminished and never feels like home.", 7),
    # ---- symmetrical and chromatic ----
    ("symmetrical", "chromatic", "Chromatic", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], None,
     "All twelve half steps in a row. Every key is the same scale, so it has no home note."),
    ("symmetrical", "whole-tone", "Whole-tone", [0, 2, 4, 6, 8, 10], None,
     "Six notes, all a whole step apart. Floating and dreamlike, because nothing in it pulls toward a tonic."),
    ("symmetrical", "diminished-wh", "Diminished (whole-half)", [0, 2, 3, 5, 6, 8, 9, 11], None,
     "Eight notes alternating whole and half steps, starting with a whole step. Used for tension over diminished chords."),
    ("symmetrical", "diminished-hw", "Diminished (half-whole)", [0, 1, 3, 4, 6, 7, 9, 10], None,
     "The same idea started on a half step. Jazz players use it over dominant seventh chords."),
    ("symmetrical", "augmented", "Augmented", [0, 3, 4, 7, 8, 11], None,
     "Six notes alternating a step and a half with a half step. Two augmented triads interlocked."),
    # ---- beyond the basics ----
    ("beyond", "phrygian-dominant", "Phrygian dominant", [0, 1, 4, 5, 7, 8, 10], None,
     "Phrygian with a major third: dark and exotic, built on a major tonic chord. The fifth mode of harmonic minor."),
    ("beyond", "lydian-dominant", "Lydian dominant", [0, 2, 4, 6, 7, 9, 10], None,
     "Lydian with a lowered seventh: bright and bluesy at once."),
    ("beyond", "harmonic-major", "Harmonic major", [0, 2, 4, 5, 7, 8, 11], None,
     "A major scale with a lowered sixth. The major scale's answer to harmonic minor."),
]

GROUPS = [
    {"id": "diatonic", "title": "Major & Diatonic Scales",
     "intro": "The seven-note scales that nearly all chord music grows from."},
    {"id": "pentatonic", "title": "Pentatonic & Blues Scales",
     "intro": "Five- and six-note scales: fewer notes, fewer ways to go wrong."},
    {"id": "modes", "title": "Modal Scales (Church Modes)",
     "intro": "Rotations of the major scale: the same seven notes, started from a different degree, each with its own colour."},
    {"id": "symmetrical", "title": "Symmetrical & Chromatic Scales",
     "intro": "Scales built from repeating shapes. Because the pattern repeats, they have no single home note."},
    {"id": "beyond", "title": "Beyond the basics",
     "intro": "Three scales you will meet the moment you leave the textbook: minor-key drama, major-key brightness."},
]

# brightest to darkest, the way people usually hear the modes
MODE_ORDER = ["lydian", "ionian", "mixolydian", "dorian", "aeolian", "phrygian", "locrian"]


def all_scales():
    out = []
    for row in _SCALES:
        group, sid, name, steps, descending, blurb = row[:6]
        mode_of = row[6] if len(row) > 6 else None
        item = {
            "id": sid, "group": group, "name": name, "steps": steps,
            "pattern": _pattern(steps), "character": blurb,
            "transpositions": _transpositions(steps),
        }
        if descending:
            item["descending"] = descending
        if mode_of:
            item["mode"] = mode_of
        out.append(item)
    return out


def scale_page_data():
    return {"groups": GROUPS, "scales": all_scales(), "modeOrder": MODE_ORDER}
