from django.test import TestCase
from django.urls import reverse

from .theory import TheoryError, identify_chord, identify_key


class IdentifyChordTests(TestCase):
    def test_c_major_triad_is_a_triad(self):
        chord = identify_chord([60, 64, 67])["chords"][0]
        self.assertEqual(chord["name"], "C")
        self.assertEqual(chord["kind"], "Triad")
        self.assertFalse(chord["inversion"])

    def test_seventh_chord_kind(self):
        chord = identify_chord([60, 64, 67, 70])["chords"][0]
        self.assertEqual(chord["name"], "C7")
        self.assertEqual(chord["kind"], "Seventh chord")

    def test_first_inversion_is_marked(self):
        chord = identify_chord([64, 67, 72])["chords"][0]
        self.assertEqual(chord["name"], "C/E")
        self.assertTrue(chord["inversion"])


class IdentifyKeyTests(TestCase):
    def names(self, notes):
        return [k["name"] for k in identify_key(notes)["keys"]]

    def test_c_major_scale_fits_c_major_and_a_minor(self):
        names = self.names([60, 62, 64, 65, 67, 69, 71])
        self.assertEqual(names[0], "C major")
        self.assertIn("A minor", names[:2])

    def test_f_sharp_points_to_g_major(self):
        result = identify_key([67, 71, 74, 66])  # G B D F#
        self.assertEqual(result["keys"][0]["name"], "G major")
        self.assertEqual(result["keys"][0]["signature"], "1 sharp: F#")

    def test_flat_keys_use_flat_names(self):
        key = identify_key([58, 62, 65, 63])["keys"][0]  # Bb D F Eb
        self.assertEqual(key["name"], "Bb major")
        self.assertEqual(key["signature"], "2 flats: Bb, Eb")

    def test_a_minor_with_a_bass_note_ranks_first(self):
        self.assertEqual(self.names([45, 48, 52])[0], "A minor")  # A C E, A in the bass

    def test_no_key_contains_every_note(self):
        # all twelve notes: no seven-note scale holds them
        self.assertEqual(identify_key(list(range(60, 72)))["keys"], [])

    def test_empty_input_is_an_error(self):
        with self.assertRaises(TheoryError):
            identify_key([])


class ApiTests(TestCase):
    def test_key_api(self):
        response = self.client.get(reverse("chords:api-key"), {"notes": "60,64,67"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["keys"])

    def test_key_api_rejects_junk(self):
        response = self.client.get(reverse("chords:api-key"), {"notes": "a,b"})
        self.assertEqual(response.status_code, 400)

    def test_studio_page_loads(self):
        self.assertEqual(self.client.get(reverse("chords:studio")).status_code, 200)


class ChordTypesTests(TestCase):
    def test_extended_chords_build_and_identify(self):
        from chords.theory import build_chord, identify_chord
        for key in ("5", "add9", "9", "maj9", "m9", "7b9", "7s9", "69", "mmaj7"):
            chord = build_chord("C", key)
            self.assertEqual(len(chord["midi"]), len(chord["notes"]))
        nine = build_chord("C", "9")
        names = [c["name"] for c in identify_chord(nine["midi"])["chords"]]
        self.assertIn("C9", names)


class ScalesTests(TestCase):
    def test_learn_page_holds_the_scales_section(self):
        response = self.client.get(reverse("chords:learn"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="scales-data"')
        self.assertContains(response, "Tonics")
        self.assertContains(response, 'id="learn-panel-notation"')
        self.assertContains(response, 'id="learn-panel-method"')

    def test_key_menu_lists_sharps_and_flats(self):
        html = self.client.get(reverse("chords:learn")).content.decode()
        for name in ["C♯", "D♭", "F♯", "G♭", "A♭", "B♭"]:
            self.assertIn(">" + name + "<", html)

    def test_old_pages_redirect_into_the_merged_ones(self):
        for name, target in [("scales", "/learn/#scales"), ("notation", "/learn/#notation"), ("songs", "/practice/#songs")]:
            response = self.client.get(reverse("chords:" + name))
            self.assertEqual(response.status_code, 301, name)
            self.assertEqual(response["Location"], target, name)
        response = self.client.get(reverse("chords:scales") + "?scale=dorian&key=3")
        self.assertEqual(response["Location"], "/learn/?scale=dorian&key=3#scales")

    def test_practice_page_holds_the_songs_section(self):
        response = self.client.get(reverse("chords:practice"))
        self.assertContains(response, 'id="practice-panel-songs"')
        self.assertContains(response, 'id="songs-import-input"')

    def test_flat_keys_are_spelled_with_flats(self):
        from .theory import build_scale, build_progression
        self.assertEqual(build_scale("Db", "major")["notes"], ["Db", "Eb", "F", "Gb", "Ab", "Bb", "C"])
        self.assertEqual(build_scale("C#", "major")["notes"][:2], ["C#", "D#"])
        self.assertEqual([c["name"] for c in build_progression("Eb", "1-4-5")["chords"]], ["Eb", "Ab", "Bb"])

    def test_every_scale_adds_up_to_an_octave(self):
        from . import scale_data
        for s in scale_data.all_scales():
            self.assertEqual(s["steps"][0], 0, s["id"])
            self.assertEqual(sorted(set(s["steps"])), s["steps"], s["id"])
            self.assertTrue(all(0 <= n < 12 for n in s["steps"]), s["id"])

    def test_symmetrical_scales_repeat(self):
        from . import scale_data
        by_id = {s["id"]: s for s in scale_data.all_scales()}
        self.assertEqual(by_id["whole-tone"]["transpositions"], 2)
        self.assertEqual(by_id["diminished-wh"]["transpositions"], 3)
        self.assertEqual(by_id["augmented"]["transpositions"], 4)
        self.assertEqual(by_id["chromatic"]["transpositions"], 1)
        self.assertEqual(by_id["major"]["transpositions"], 12)

    def test_major_pattern_and_modes(self):
        from . import scale_data
        by_id = {s["id"]: s for s in scale_data.all_scales()}
        self.assertEqual(by_id["major"]["pattern"], "W-W-H-W-W-W-H")
        self.assertEqual(by_id["harmonic-minor"]["pattern"], "W-H-W-W-H-W+H-H")
        for mode in scale_data.MODE_ORDER:
            self.assertIn(mode, by_id)

    def test_studio_gets_the_scale_list(self):
        response = self.client.get(reverse("chords:studio"))
        self.assertContains(response, 'id="studio-scales-data"')
        self.assertContains(response, "Dorian")
