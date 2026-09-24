package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
)

// maxFrameBytes is the largest accepted frame, excluding its terminating newline.
const maxFrameBytes = 16 << 20

// errFrameTooLong reports an input line longer than maxFrameBytes, a fatal protocol error.
var errFrameTooLong = errors.New("frame exceeds the 16 MiB limit")

// request is a controller → envd frame.
type request struct {
	T  string          `json:"t"`
	ID int64           `json:"id"`
	M  string          `json:"m"`
	P  json.RawMessage `json:"p"`
}

// response answers one request; R is set on success and E on failure.
type response struct {
	T  string      `json:"t"`
	ID int64       `json:"id"`
	OK bool        `json:"ok"`
	R  any         `json:"r,omitempty"`
	E  *protoError `json:"e,omitempty"`
}

// event is an unsolicited envd → controller frame.
type event struct {
	T string `json:"t"`
	M string `json:"m"`
	P any    `json:"p"`
}

// readFrame returns the next line from br without its newline. A final line that lacks a newline
// is still returned; io.EOF is returned only once no bytes remain.
func readFrame(br *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		switch {
		case err == nil:
			line = line[:len(line)-1]
			if len(line) > limit {
				return nil, errFrameTooLong
			}
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			if len(line) > limit {
				return nil, errFrameTooLong
			}
		case errors.Is(err, io.EOF):
			if len(line) == 0 {
				return nil, io.EOF
			}
			if len(line) > limit {
				return nil, errFrameTooLong
			}
			return line, nil
		default:
			return nil, err
		}
	}
}

// frameWriter writes frames to the controller. Each frame is encoded up front and written with a
// single Write under a mutex, so frames from concurrent handlers never interleave. After the first
// write error frames are dropped: the controller is gone and envd will see EOF on its input.
type frameWriter struct {
	mu     sync.Mutex
	w      io.Writer
	broken bool
}

// send encodes frame as one JSON line and writes it.
func (fw *frameWriter) send(frame any) {
	b, err := json.Marshal(frame)
	if err != nil {
		log.Printf("encoding frame: %v", err)
		return
	}
	b = append(b, '\n')
	fw.mu.Lock()
	defer fw.mu.Unlock()
	if fw.broken {
		return
	}
	if _, err := fw.w.Write(b); err != nil {
		fw.broken = true
		log.Printf("writing frame: %v", err)
	}
}

// respond writes the response to request id: a failure when err is non-nil, a success otherwise.
func (fw *frameWriter) respond(id int64, result any, err error) {
	if err != nil {
		fw.send(response{T: "res", ID: id, OK: false, E: toProtoError(err)})
		return
	}
	if result == nil {
		result = struct{}{}
	}
	fw.send(response{T: "res", ID: id, OK: true, R: result})
}

// emit writes an event frame.
func (fw *frameWriter) emit(method string, payload any) {
	fw.send(event{T: "evt", M: method, P: payload})
}
