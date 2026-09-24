import notes


def test_add_then_list(tmp_path, monkeypatch):
    monkeypatch.setattr(notes, "STORE", tmp_path / "notes.json")
    notes.add("water the lilies")
    assert notes.load() == ["water the lilies"]
