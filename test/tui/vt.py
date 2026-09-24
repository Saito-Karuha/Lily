"""A small VT100/xterm screen emulator, enough to follow pi-tui's main-screen renderer
(cursor moves, line/screen clears, scrolling, wide characters) without third-party
packages. Colors and other attributes are ignored; `screen()` returns plain text rows."""
import codecs
import re
import unicodedata

_CSI = re.compile(r"\x1b\[([0-?]*)([ -/]*)([@-~])")


def char_width(ch):
    if unicodedata.combining(ch) or ch in "​‍️":
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Screen:
    def __init__(self, width=100, height=30):
        self.width = width
        self.height = height
        self.lines = [[] for _ in range(height)]  # scrollback + screen, each a list of cells
        self.top = 0  # buffer index of the first screen row
        self.row = 0  # cursor row relative to the screen
        self.col = 0
        self.pending_wrap = False
        self._rest = ""
        self._decoder = codecs.getincrementaldecoder("utf8")("replace")

    # ── helpers ──────────────────────────────────────────────────────────
    def _line(self):
        idx = self.top + self.row
        while len(self.lines) <= idx:
            self.lines.append([])
        return self.lines[idx]

    def _newline(self):
        if self.row < self.height - 1:
            self.row += 1
        else:
            self.top += 1
        self._line()

    def _put(self, ch):
        w = char_width(ch)
        if w == 0:
            return
        if self.pending_wrap or self.col + w > self.width:
            self.col = 0
            self._newline()
            self.pending_wrap = False
        line = self._line()
        while len(line) < self.col + w:
            line.append(" ")
        line[self.col] = ch
        if w == 2:
            line[self.col + 1] = ""
        self.col += w
        if self.col >= self.width:
            self.col = self.width - 1
            self.pending_wrap = True

    def _csi(self, params, final):
        nums = [int(p) if p.isdigit() else 0 for p in params.lstrip("?>=<").split(";")] if params else []
        n = nums[0] if nums and nums[0] > 0 else 1
        if params.startswith(("?", ">", "=", "<")):
            return  # private modes, queries
        self.pending_wrap = False
        if final == "A":
            self.row = max(0, self.row - n)
        elif final == "B":
            self.row = min(self.height - 1, self.row + n)
            self._line()
        elif final == "C":
            self.col = min(self.width - 1, self.col + n)
        elif final == "D":
            self.col = max(0, self.col - n)
        elif final == "G":
            self.col = min(self.width - 1, n - 1)
        elif final in "Hf":
            r = nums[0] if nums and nums[0] > 0 else 1
            c = nums[1] if len(nums) > 1 and nums[1] > 0 else 1
            self.row, self.col = min(self.height, r) - 1, min(self.width, c) - 1
            self._line()
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 3:
                self.lines = self.lines[self.top:]
                self.top = 0
            elif mode == 2:
                for i in range(self.height):
                    idx = self.top + i
                    if idx < len(self.lines):
                        self.lines[idx] = []
            elif mode == 0:
                line = self._line()
                del line[self.col:]
                for i in range(self.row + 1, self.height):
                    idx = self.top + i
                    if idx < len(self.lines):
                        self.lines[idx] = []
        elif final == "K":
            mode = nums[0] if nums else 0
            line = self._line()
            if mode == 2:
                line.clear()
            elif mode == 0:
                del line[self.col:]
            elif mode == 1:
                for i in range(min(self.col + 1, len(line))):
                    line[i] = " "

    # ── public ───────────────────────────────────────────────────────────
    def feed(self, data):
        if isinstance(data, bytes):
            data = self._decoder.decode(data)
        data = self._rest + data
        self._rest = ""
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    self._rest = data[i:]
                    return
                nxt = data[i + 1]
                if nxt == "[":
                    m = _CSI.match(data, i)
                    if not m:
                        self._rest = data[i:]
                        return
                    self._csi(m.group(1), m.group(3))
                    i = m.end()
                    continue
                if nxt in "]_P^X":  # OSC / APC / DCS / PM / SOS: skip to BEL or ST
                    end_bel = data.find("\x07", i + 2)
                    end_st = data.find("\x1b\\", i + 2)
                    ends = [e for e in (end_bel, end_st) if e != -1]
                    if not ends:
                        self._rest = data[i:]
                        return
                    end = min(ends)
                    i = end + (1 if end == end_bel else 2)
                    continue
                i += 2
                continue
            if ch == "\r":
                self.col = 0
                self.pending_wrap = False
            elif ch == "\n":
                self._newline()
                self.pending_wrap = False
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.width - 1, (self.col // 8 + 1) * 8)
            elif ord(ch) >= 32:
                self._put(ch)
            i += 1

    def screen(self):
        rows = []
        for i in range(self.height):
            idx = self.top + i
            rows.append("".join(self.lines[idx]).rstrip() if idx < len(self.lines) else "")
        return rows

    def text(self):
        return "\n".join(self.screen())

    def history(self):
        return "\n".join("".join(line).rstrip() for line in self.lines)
