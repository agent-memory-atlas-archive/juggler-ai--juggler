//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"cmp"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/bmatcuk/doublestar/v4"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/gitignore"
)

// TreeOperations handles directory tree operations
type TreeOperations struct {
	scope PathScope
}

// NewTreeOperations creates a new tree operations handler
func NewTreeOperations(scope PathScope) *TreeOperations {
	return &TreeOperations{
		scope: scope,
	}
}

// Execute executes a tree operation
func (ops *TreeOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "getTree":
		return ops.getTree(params)
	case "expandDirectory":
		return ops.expandDirectory(params)
	case "glob":
		return ops.glob(ctx, params)
	case "copy":
		return ops.copyTree(ctx, params)
	case "compare":
		return ops.compareTrees(ctx, params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// getTree returns the file tree structure with token budget awareness
func (ops *TreeOperations) getTree(params map[string]any) (any, error) {
	path := "."
	if p, ok := params["path"].(string); ok && p != "" {
		path = p
	}

	// SECURITY: Validate path. A user-initiated tree (a folder pinned via
	// @-mention or the file picker) may point outside the project root, just
	// like a user-initiated file read; the escape hatch covers relative
	// (../sibling) and absolute mentions alike. LLM tool calls stay contained.
	userInitiated, _ := params["userInitiated"].(bool)
	absPath, err := ops.scope.ResolveUserInitiated(path, userInitiated)
	if err != nil {
		return nil, err
	}

	// SECURITY: Validate depth parameter (prevent stack overflow)
	depth := 2
	if d, ok := params["depth"]; ok {
		validatedDepth, err := ValidateTreeDepth(d)
		if err != nil {
			return nil, err
		}
		depth = validatedDepth
	}

	// Get maxTokens parameter (default: 2000 as fallback)
	maxTokens := 2000
	if mt, ok := params["maxTokens"].(float64); ok {
		maxTokens = max(int(mt),
			// Minimum reasonable budget
			100)
	} else if params["maxTokens"] != nil {
		return nil, fmt.Errorf("maxTokens must be a number, got %T", params["maxTokens"])
	}

	// Get pattern filter (glob matching)
	pattern := ""
	if p, ok := params["pattern"].(string); ok {
		pattern = p
	} else if params["pattern"] != nil {
		return nil, fmt.Errorf("pattern must be a string, got %T", params["pattern"])
	}

	// Get fileType filter (all, files, dirs)
	fileType := "all"
	if ft, ok := params["fileType"].(string); ok {
		if ft == "files" || ft == "dirs" {
			fileType = ft
		}
	} else if params["fileType"] != nil {
		return nil, fmt.Errorf("fileType must be a string, got %T", params["fileType"])
	}

	// Get showAll parameter (default: false)
	// When true: include hidden files and ignore .gitignore
	showAll := false
	if sa, ok := params["showAll"].(bool); ok {
		showAll = sa
	} else if params["showAll"] != nil {
		return nil, fmt.Errorf("showAll must be a boolean, got %T", params["showAll"])
	}

	// Get noIgnore parameter (default: false). Unlike showAll it only releases
	// .gitignore filtering; hidden files stay hidden. showAll implies it.
	noIgnore := showAll
	if ni, ok := params["noIgnore"].(bool); ok && ni {
		noIgnore = true
	} else if params["noIgnore"] != nil {
		if _, ok := params["noIgnore"].(bool); !ok {
			return nil, fmt.Errorf("noIgnore must be a boolean, got %T", params["noIgnore"])
		}
	}

	// Ensure path exists
	if _, err = os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("path does not exist: %w", err)
	}

	// Build a gitignore matcher unless opted out (nil = filtering off), rooted
	// at the project root; relative paths are computed against it.
	var ign *gitignore.Matcher
	if !noIgnore {
		ign = gitignore.NewMatcher(ops.scope.Root())
	}

	// Build tree with token budget awareness
	buildCtx := &buildContext{
		tokensUsed:     0,
		maxTokens:      maxTokens,
		pattern:        pattern,
		fileType:       fileType,
		maxItemsPerDir: 500, // Hard limit to prevent CPU burnout
		maxDepth:       depth,
		showAll:        showAll,
		ign:            ign,
		workingDir:     ops.scope.Root(),
	}

	stats := &treeStats{}
	tree, err := buildTreeWithBudget(absPath, 0, buildCtx, stats)
	if err != nil {
		return nil, fmt.Errorf("failed to build tree: %w", err)
	}

	return map[string]any{
		"content":             tree,
		"path":                path,
		"depth":               depth,
		"fileCount":           stats.files,
		"dirCount":            stats.dirs,
		"tokensUsed":          buildCtx.tokensUsed,
		"maxTokens":           maxTokens,
		"pattern":             pattern,
		"fileType":            fileType,
		"truncated":           buildCtx.truncated,
		"hiddenFilesExcluded": stats.hiddenSkipped,
		"hiddenFilesIncluded": showAll,
	}, nil
}

// buildContext holds state during tree building
type buildContext struct {
	tokensUsed     int
	maxTokens      int
	pattern        string
	fileType       string
	maxItemsPerDir int
	maxDepth       int
	truncated      bool
	showAll        bool               // When true, include hidden files and ignore .gitignore
	ign            *gitignore.Matcher // gitignore matcher (nil = filtering off)
	workingDir     string             // Root working directory for relative path calculation
}

// treeStats holds statistics about the tree
type treeStats struct {
	files         int
	dirs          int
	hiddenSkipped int // Count of hidden files/dirs that were excluded
}

// treeEntry holds information about a file or directory
type treeEntry struct {
	name      string
	isDir     bool
	size      int64
	itemCount int // for directories: number of items
}

// buildTreeWithBudget recursively builds a tree structure with token budget awareness
func buildTreeWithBudget(root string, depth int, ctx *buildContext, stats *treeStats) (string, error) {
	// Check depth limit
	if depth >= ctx.maxDepth {
		return "", nil
	}

	// Check token budget
	if ctx.tokensUsed >= ctx.maxTokens {
		ctx.truncated = true
		return "", nil
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}

	// Calculate relative path for gitignore matching
	relPath := ""
	if ctx.workingDir != "" {
		relPath, _ = filepath.Rel(ctx.workingDir, root)
		if relPath == "." {
			relPath = ""
		}
	}

	// Collect and filter entries
	var treeEntries []*treeEntry
	skippedCount := 0
	filteredCount := 0 // Track items filtered by pattern/fileType

	for _, entry := range entries {
		// Skip hidden files and common bloat directories
		shouldSkip, isHidden := shouldSkipEntry(entry.Name(), relPath, entry.IsDir(), ctx)
		if shouldSkip {
			skippedCount++
			if isHidden {
				stats.hiddenSkipped++
			}
			continue
		}

		// Apply pattern filter
		if ctx.pattern != "" && !matchesPattern(entry.Name(), ctx.pattern) {
			filteredCount++
			continue
		}

		// Apply file type filter
		if ctx.fileType == "files" && entry.IsDir() {
			filteredCount++
			continue
		}
		if ctx.fileType == "dirs" && !entry.IsDir() {
			filteredCount++
			continue
		}

		// Get entry info with size
		te, err := getEntryInfo(root, entry, ctx)
		if err != nil {
			// Skip on error but don't fail entire operation
			continue
		}

		treeEntries = append(treeEntries, te)

		// Hard limit to prevent CPU burnout on huge directories
		if len(treeEntries) >= ctx.maxItemsPerDir {
			break
		}
	}

	// Calculate how many items were not processed due to item limit
	// (exclude filtered items - they were intentionally excluded by pattern/fileType)
	matchingEntries := len(entries) - skippedCount - filteredCount
	truncatedCount := matchingEntries - len(treeEntries)

	var builder strings.Builder
	indent := strings.Repeat("-", depth+1) + " " // Dash-per-level format: depth shown by dash count

	// Process each entry
	for i, te := range treeEntries {
		// Build line with metadata
		line := indent + te.name

		if te.isDir {
			// Directory: only show item count if it's collapsed (not being expanded)
			willExpand := depth+1 < ctx.maxDepth && ctx.tokensUsed < ctx.maxTokens
			if !willExpand {
				// Directory is collapsed - show item count with correct plural
				itemWord := "items"
				if te.itemCount == 1 {
					itemWord = "item"
				}
				line += fmt.Sprintf("/\t[%d %s]", te.itemCount, itemWord)
			} else {
				// Directory is expanded - just show slash, no count (it's redundant)
				line += "/"
			}
			stats.dirs++
		} else {
			// File with size (tab-delimited for easier parsing)
			line += fmt.Sprintf("\t[%s]", formatSize(te.size))
			stats.files++
		}

		line += "\n"

		// Check if adding this line would exceed token budget
		lineTokens := provider.EstimateTokens(line)
		if ctx.tokensUsed+lineTokens > ctx.maxTokens {
			// Budget exhausted - add summary and stop
			remaining := len(treeEntries) - i
			if remaining > 0 {
				summary := fmt.Sprintf("%s... and %d more items (token budget exhausted)\n", indent, remaining)
				builder.WriteString(summary)
				ctx.tokensUsed += provider.EstimateTokens(summary)
				ctx.truncated = true
			}
			break
		}

		// Add line to output
		builder.WriteString(line)
		ctx.tokensUsed += lineTokens

		// Recurse into directory if within depth limit
		if te.isDir && depth+1 < ctx.maxDepth && ctx.tokensUsed < ctx.maxTokens {
			subTree, err := buildTreeWithBudget(filepath.Join(root, te.name), depth+1, ctx, stats)
			if err == nil && subTree != "" {
				builder.WriteString(subTree)
			}
		}
	}

	// Add truncation summary if items were skipped
	if truncatedCount > 0 {
		summary := fmt.Sprintf("%s... and %d more items\n", indent, truncatedCount)
		builder.WriteString(summary)
		ctx.tokensUsed += provider.EstimateTokens(summary)
		ctx.truncated = true
	}

	return builder.String(), nil
}

// getEntryInfo collects metadata about a file or directory
func getEntryInfo(root string, entry os.DirEntry, ctx *buildContext) (*treeEntry, error) {
	info, err := entry.Info()
	if err != nil {
		return nil, err
	}

	te := &treeEntry{
		name:  entry.Name(),
		isDir: entry.IsDir(),
		size:  info.Size(),
	}

	// If directory, calculate item count
	if entry.IsDir() {
		te.itemCount = countDirectoryItems(filepath.Join(root, entry.Name()), ctx)
	}

	return te, nil
}

// countDirectoryItems counts the number of items in a directory
func countDirectoryItems(path string, ctx *buildContext) int {
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}

	// Calculate relative path for gitignore matching
	relPath := ""
	if ctx != nil && ctx.workingDir != "" {
		relPath, _ = filepath.Rel(ctx.workingDir, path)
		if relPath == "." {
			relPath = ""
		}
	}

	count := 0
	for _, entry := range entries {
		// Skip hidden files and common bloat
		shouldSkip, _ := shouldSkipEntry(entry.Name(), relPath, entry.IsDir(), ctx)
		if shouldSkip {
			continue
		}
		count++
	}

	return count
}

// matchesPattern checks if a name matches a glob pattern
func matchesPattern(name, pattern string) bool {
	if pattern == "" {
		return true
	}
	matched, err := filepath.Match(pattern, name)
	if err != nil {
		return false
	}
	return matched
}

// formatSize formats bytes in human-readable format
func formatSize(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}

	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}

	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}

	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// shouldSkipEntry determines if a file/directory should be skipped in the tree
// Returns (shouldSkip, isHidden) - isHidden indicates if it was skipped due to being hidden
func shouldSkipEntry(name string, relPath string, isDir bool, ctx *buildContext) (bool, bool) {
	// If showAll is true, only skip truly useless directories
	if ctx.showAll {
		// Even with showAll, skip node_modules as it's massive and never useful
		if name == "node_modules" {
			return true, false
		}
		return false, false
	}

	// Skip hidden files (starting with .)
	if strings.HasPrefix(name, ".") {
		return true, true
	}

	// Skip common directories that bloat the tree
	skipDirs := []string{
		"node_modules",
		"vendor",
		"__pycache__",
		"build",
		"dist",
		"target",
		"bin",
		"obj",
		".next",
		".nuxt",
		"coverage",
	}

	if slices.Contains(skipDirs, name) {
		return true, false
	}

	// Check .gitignore patterns (relPath is slash-separated relative to the
	// project root; the matcher is nil when filtering is off).
	childRel := name
	if relPath != "" {
		childRel = filepath.ToSlash(filepath.Join(relPath, name))
	}
	if ctx.ign.Ignored(childRel, isDir) {
		return true, false
	}

	return false, false
}

// glob returns files matching a glob pattern, sorted by modification time
func (ops *TreeOperations) glob(ctx context.Context, params map[string]any) (any, error) {
	pattern, ok := params["pattern"].(string)
	if !ok || pattern == "" {
		return nil, fmt.Errorf("pattern is required")
	}

	// Get optional path parameter (directory to search in)
	searchPath := "."
	if p, ok := params["path"].(string); ok && p != "" {
		searchPath = p
	}

	// SECURITY: Validate path. ResolveRead honours a user-initiated pin and the
	// JS out-of-root approval (the glob `pattern` is expanded within this
	// resolved dir and cannot escape it), so an approved out-of-project glob
	// resolves instead of being rejected.
	userInitiated, _ := params["userInitiated"].(bool)
	approved, _ := params["outOfRootApproved"].(bool)
	absPath, err := ops.scope.ResolveRead(searchPath, userInitiated, approved)
	if err != nil {
		return nil, err
	}

	// Build a gitignore matcher unless opted out (nil = filtering off), rooted
	// at the resolved search directory.
	noIgnore := false
	if ni, ok := params["noIgnore"].(bool); ok {
		noIgnore = ni
	}
	var ign *gitignore.Matcher
	if !noIgnore {
		ign = gitignore.NewMatcher(absPath)
	}

	// Collect file info for sorting and filtering
	type fileInfo struct {
		path    string
		modTime int64
	}
	var files []fileInfo

	// Walk the tree, pruning gitignored directories so large ignored subtrees
	// (node_modules, build output) are never descended into. This matches
	// doublestar.Glob's rel-path match semantics but avoids traversing pruned
	// dirs. An invalid pattern surfaces on the first Match call below.
	if _, perr := doublestar.Match(pattern, ""); perr != nil {
		return nil, fmt.Errorf("invalid glob pattern: %w", perr)
	}
	fsys := os.DirFS(absPath)
	_ = fs.WalkDir(fsys, ".", func(rel string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries, keep walking
		}
		// Stop early if the client cancelled the request (Escape).
		if ctx.Err() != nil {
			return fs.SkipAll
		}
		if rel == "." {
			return nil
		}

		if d.IsDir() {
			if ign.Ignored(rel, true) {
				return fs.SkipDir
			}
			return nil
		}

		// Skip gitignored files.
		if ign.Ignored(rel, false) {
			return nil
		}

		if ok, _ := doublestar.Match(pattern, rel); !ok {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return nil // skip files we can't stat
		}

		// Build relative path from the working directory. If searchPath is ".",
		// rel is already relative to workingDir; otherwise prefix searchPath.
		relPath := rel
		if searchPath != "." {
			// filepath.Join uses the OS separator (\ on Windows); tool results
			// are always POSIX-style, so normalise back to forward slashes.
			relPath = filepath.ToSlash(filepath.Join(searchPath, rel))
		}

		files = append(files, fileInfo{
			path:    relPath,
			modTime: info.ModTime().Unix(),
		})
		return nil
	})

	// Sort by modification time (newest first)
	slices.SortFunc(files, func(a, b fileInfo) int {
		return cmp.Compare(b.modTime, a.modTime)
	})

	// Extract just the paths
	var result []string
	for _, f := range files {
		result = append(result, f.path)
	}

	// Limit results to prevent huge responses
	maxResults := 1000
	truncated := false
	if len(result) > maxResults {
		result = result[:maxResults]
		truncated = true
	}

	return map[string]any{
		"files":     result,
		"pattern":   pattern,
		"path":      searchPath,
		"count":     len(result),
		"truncated": truncated,
	}, nil
}

// expandDirectory expands a directory to show its contents
func (ops *TreeOperations) expandDirectory(params map[string]any) (any, error) {
	path, ok := params["path"].(string)
	if !ok {
		return nil, fmt.Errorf("missing or invalid 'path' parameter")
	}

	// Resolve and confirm the path stays within the working directory (or an
	// allowed root), using the same containment check as the other
	// read/search/tree ops.
	validation, err := ops.scope.Resolve(path)
	if err != nil {
		return nil, err
	}
	absPath := validation.AbsPath

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	var items []map[string]any
	for _, entry := range entries {
		items = append(items, map[string]any{
			"name":  entry.Name(),
			"isDir": entry.IsDir(),
			// POSIX-style path in results, even on Windows (filepath.Join → \).
			"path": filepath.ToSlash(filepath.Join(path, entry.Name())),
		})
	}

	return map[string]any{
		"items": items,
		"path":  path,
	}, nil
}
