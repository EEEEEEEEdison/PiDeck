package main

import (
	"bytes"
	"runtime"
	"sort"
	"sync"
	"unicode/utf8"
)

// ── 搜索：语料分片 + 并发 ReadAt 扫描 ─────────────────────────────────────
//
// 不建倒排索引（全量倒排 >1GB 堆内存，否决）——查询时把 entries 按语料
// offset 排序后均分为 N 片，每 worker 用 ReadAt 只读自己片的字节范围再
// bytes.Contains（页缓存命中时为 memcpy 速度；冷读走磁盘顺序 IO）。大小写
// 处理：query 纯 CJK/无 ASCII 字母时直接原文 contains（快路径，中文用户
// 常态）；含 ASCII 字母则每 entry ASCII-lower 到线程本地 buffer 再匹配。

type searchMatch struct {
	MessageId   string `json:"messageId"`
	Role        string `json:"role"`
	TimestampMs int64  `json:"timestampMs"`
	Snippet     string `json:"snippet"`
}

type searchSessionHits struct {
	FilePath    string        `json:"filePath"`
	UpdatedAtMs int64         `json:"updatedAtMs"`
	Matches     []searchMatch `json:"matches"`
}

type searchResult struct {
	Sessions         []searchSessionHits `json:"sessions"`
	TotalHitSessions int                 `json:"totalHitSessions"`
	Truncated        bool                `json:"truncated"`
}

const (
	snippetBeforeRunes = 48
	snippetAfterRunes  = 96
	snippetMaxBytes    = 512
)

type hit struct {
	entryIdx        int
	hitOffsetInText int
}

func (ix *Indexer) Search(query string, limit, perSession int) searchResult {
	q := []byte(query)
	asciiFold := containsASCIILetter(q)
	var lowerQ []byte
	if asciiFold {
		lowerQ = asciiLowerTo(nil, q)
	}

	// 全程读锁：rescan/compact（写锁）等本搜索结束；corpusFile 的 ReadAt 与
	// 追加写并发安全（写侧只在写锁内推进 corpusSize，读侧只碰已发布 entry）。
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	if ix.corpusFile == nil || len(ix.entries) == 0 {
		return searchResult{Sessions: []searchSessionHits{}}
	}
	entries := make([]entry, len(ix.entries))
	copy(entries, ix.entries)
	sortEntriesByOffset(entries)
	corpus := ix.corpusFile

	// 均分 entries（offset 有序 → 每片对应连续语料段，worker 只 ReadAt 自己的段）
	workers := parallelWorkers()
	if workers > len(entries) {
		workers = len(entries)
	}
	if workers < 1 {
		workers = 1
	}
	chunk := (len(entries) + workers - 1) / workers
	type chunkHits struct {
		hits []hit
		text []byte // 片缓冲复用给 snippet 构建，避免二次读
	}
	results := make([]chunkHits, workers)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		start, end := w*chunk, (w+1)*chunk
		if end > len(entries) {
			end = len(entries)
		}
		if start >= end {
			continue
		}
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			first := entries[start]
			last := entries[end-1]
			segStart := first.offset
			segLen := last.offset + int64(last.length) - segStart
			if segLen <= 0 {
				return
			}
			buf := make([]byte, segLen)
			if _, err := corpus.ReadAt(buf, segStart); err != nil {
				logf("read corpus segment failed: %v", err)
				return
			}
			var lowerBuf []byte
			var found []hit
			for i := start; i < end; i++ {
				e := &entries[i]
				text := buf[e.offset-segStart : e.offset-segStart+int64(e.length)]
				var at int
				if asciiFold {
					lowerBuf = asciiLowerTo(lowerBuf[:0], text)
					at = bytes.Index(lowerBuf, lowerQ)
				} else {
					at = bytes.Index(text, q)
				}
				if at >= 0 {
					found = append(found, hit{entryIdx: i, hitOffsetInText: at})
				}
			}
			results[w] = chunkHits{hits: found, text: buf}
		}(w)
	}
	wg.Wait()

	// 片内命中收集；snippet 从片缓冲取（offset 归一化到 entry 内）
	type resolvedHit struct {
		e    *entry
		text []byte // entry 正文（来自片缓冲）
		at   int
	}
	var all []resolvedHit
	for w := 0; w < workers; w++ {
		ch := results[w]
		for _, h := range ch.hits {
			e := &entries[h.entryIdx]
			segStart := entries[w*chunk].offset
			text := ch.text[e.offset-segStart : e.offset-segStart+int64(e.length)]
			all = append(all, resolvedHit{e: e, text: text, at: h.hitOffsetInText})
		}
	}

	// 聚合到会话：entries 顺序即语料/时间序，会话内命中天然按时间排列
	type sessionAgg struct {
		fs      *fileState
		matches []searchMatch
	}
	fileById := make(map[int32]*fileState, len(ix.files))
	for _, fs := range ix.files {
		fileById[fs.FileId] = fs
	}
	aggByFile := make(map[int32]*sessionAgg)
	var order []int32
	for _, rh := range all {
		agg := aggByFile[rh.e.fileRef]
		if agg == nil {
			fs := fileById[rh.e.fileRef]
			if fs == nil {
				continue
			}
			agg = &sessionAgg{fs: fs}
			aggByFile[rh.e.fileRef] = agg
			order = append(order, rh.e.fileRef)
		}
		if len(agg.matches) >= perSession {
			continue
		}
		agg.matches = append(agg.matches, searchMatch{
			MessageId:   string(rh.e.msgId),
			Role:        roleName(rh.e.role),
			TimestampMs: rh.e.tsMs,
			Snippet:     buildSnippet(rh.text, rh.at),
		})
	}
	sessions := make([]searchSessionHits, 0, len(order))
	for _, fileRef := range order {
		agg := aggByFile[fileRef]
		sessions = append(sessions, searchSessionHits{FilePath: agg.fs.Path, UpdatedAtMs: agg.fs.UpdatedAtMs, Matches: agg.matches})
	}
	// 最近活跃的会话优先（时间相同按路径稳定排序）
	sort.SliceStable(sessions, func(i, j int) bool {
		if sessions[i].UpdatedAtMs != sessions[j].UpdatedAtMs {
			return sessions[i].UpdatedAtMs > sessions[j].UpdatedAtMs
		}
		return sessions[i].FilePath < sessions[j].FilePath
	})
	total := len(sessions)
	truncated := total > limit
	if truncated {
		sessions = sessions[:limit]
	}
	return searchResult{Sessions: sessions, TotalHitSessions: total, Truncated: truncated}
}

// buildSnippet：命中处前 snippetBeforeRunes / 后 snippetAfterRunes 个 rune，
// clamp 到 entry 边界；换行折叠为空格（snippet 单行展示）。返回合法 UTF-8。
func buildSnippet(text []byte, at int) string {
	start := at - snippetMaxBytes
	if start < 0 {
		start = 0
	}
	end := at + snippetMaxBytes
	if end > len(text) {
		end = len(text)
	}
	for start > 0 && at-start < snippetMaxBytes && !isRuneStart(text[start]) {
		start--
	}
	for end < len(text) && end-at < snippetMaxBytes && !isRuneStart(text[end]) {
		end++
	}
	start = retreatRunes(text, start, at, snippetBeforeRunes)
	end = advanceRunes(text, end, at, snippetAfterRunes)

	raw := text[start:end]
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); {
		r, size := utf8.DecodeRune(raw[i:])
		if r == '\n' || r == '\r' || r == '\t' {
			out = append(out, ' ')
			i += size
			continue
		}
		out = append(out, raw[i:i+size]...)
		i += size
	}
	return string(out)
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func retreatRunes(text []byte, start, at, maxRunes int) int {
	count := 0
	for start > 0 && count < maxRunes {
		start--
		if isRuneStart(text[start]) {
			count++
		}
	}
	return start
}

func advanceRunes(text []byte, end, at, maxRunes int) int {
	count := 0
	for end < len(text) && count < maxRunes {
		_, size := utf8.DecodeRune(text[end:])
		if size == 0 {
			break
		}
		end += size
		count++
	}
	return end
}

func containsASCIILetter(q []byte) bool {
	for _, b := range q {
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') {
			return true
		}
	}
	return false
}

// asciiLowerTo：只折叠 ASCII A-Z（中文等非 ASCII 字节不动，保语义）。
func asciiLowerTo(dst, src []byte) []byte {
	if cap(dst) < len(src) {
		dst = make([]byte, len(src))
	}
	dst = dst[:len(src)]
	for i, b := range src {
		if b >= 'A' && b <= 'Z' {
			dst[i] = b + 32
		} else {
			dst[i] = b
		}
	}
	return dst
}

func parallelWorkers() int {
	n := runtime.NumCPU()
	if n > 8 {
		n = 8
	}
	return n
}
