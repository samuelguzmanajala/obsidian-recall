package com.recall.voice.ui

/**
 * Small Markdown subset for card sides: paragraphs, headings, lists, fenced code, inline emphasis,
 * TeX math (`$...$` inline, `$$...$$` display) and image embeds.
 */
sealed interface MdBlock {
  data class Paragraph(val spans: List<MdInline>) : MdBlock
  data class Heading(val spans: List<MdInline>) : MdBlock
  data class Item(val marker: String, val depth: Int, val spans: List<MdInline>) : MdBlock
  data class Code(val text: String) : MdBlock

  /** Display math: the LaTeX source between `$$` delimiters, trimmed. */
  data class Math(val latex: String) : MdBlock

  /**
   * An embedded image (`![[file.png]]` or `![alt](path)`). [target] is the vault path or URL as
   * written, so the image itself can be loaded once the server serves attachments.
   */
  data class Image(val target: String, val alt: String = "") : MdBlock {
    /** The last path segment of [target], for telling the reader which image is missing. */
    val fileName: String
      get() = target.substringBefore('?').trimEnd('/').substringAfterLast('/').replace("%20", " ").ifEmpty { target }
  }
}

/** A run inside a paragraph, heading or list item. */
sealed interface MdInline

data class MdSpan(
  val text: String,
  val bold: Boolean = false,
  val italic: Boolean = false,
  val code: Boolean = false,
  val mark: Boolean = false,
) : MdInline

/** Inline math: the LaTeX source between `$` delimiters. */
data class MdMath(val latex: String) : MdInline

private val FENCE = Regex("^\\s*(```|~~~)")
private val HEADING = Regex("^#{1,6}\\s+(.*)$")
private val BULLET = Regex("^(\\s*)[-*+]\\s+(.*)$")
private val ORDERED = Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$")

/** Obsidian's image formats: an embed of any other file is a note or attachment, not a picture. */
private val IMAGE_EXTENSIONS = setOf("avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp")

/** `![[path]]`, `![[path|300]]` or `![[path#anchor]]`. */
private val IMAGE_WIKI = Regex("!\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|[^\\]]*)?]]")

/** `![alt](path)`, `![alt](<path with spaces>)` or `![alt](path "title")`. */
private val IMAGE_MD = Regex("!\\[([^\\]]*)]\\((<[^>]*>|[^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")

fun parseMarkdown(source: String): List<MdBlock> {
  val blocks = mutableListOf<MdBlock>()
  val paragraph = mutableListOf<String>()
  fun flush() {
    if (paragraph.isNotEmpty()) blocks += MdBlock.Paragraph(parseInline(paragraph.joinToString(" ")))
    paragraph.clear()
  }
  /** Adds paragraph text, splitting image embeds out into their own blocks. */
  fun addText(text: String) {
    var from = 0
    for ((range, image) in findImages(text)) {
      text.substring(from, range.first).trim().takeIf { it.isNotEmpty() }?.let { paragraph += it }
      flush()
      blocks += image
      from = range.last + 1
    }
    text.substring(from).trim().takeIf { it.isNotEmpty() }?.let { paragraph += it }
  }
  val lines = source.replace("\r\n", "\n").split('\n').toMutableList()
  var i = 0
  while (i < lines.size) {
    val line = lines[i]
    if (FENCE.containsMatchIn(line)) {
      flush()
      val code = mutableListOf<String>()
      i++
      while (i < lines.size && !FENCE.containsMatchIn(lines[i])) code += lines[i++]
      blocks += MdBlock.Code(code.joinToString("\n"))
      i++
      continue
    }
    val heading = HEADING.find(line)
    val bullet = BULLET.find(line)
    val ordered = ORDERED.find(line)
    when {
      line.isBlank() -> flush()
      heading != null -> { flush(); blocks += MdBlock.Heading(parseInline(heading.groupValues[1])) }
      bullet != null -> {
        flush()
        blocks += MdBlock.Item("•", bullet.groupValues[1].length / 2, parseInline(bullet.groupValues[2]))
      }
      ordered != null -> {
        flush()
        blocks += MdBlock.Item("${ordered.groupValues[2]}.", ordered.groupValues[1].length / 2, parseInline(ordered.groupValues[3]))
      }
      else -> {
        val display = findDisplayMath(lines, i)
        if (display != null) {
          addText(line.substring(0, display.openAt))
          flush()
          blocks += MdBlock.Math(display.latex)
          // Whatever follows the closing `$$` is read again as a line of its own.
          lines[display.endLine] = lines[display.endLine].substring(display.endAt)
          i = display.endLine
          continue
        }
        addText(line)
      }
    }
    i++
  }
  flush()
  return blocks
}

private class DisplayMath(val openAt: Int, val latex: String, val endLine: Int, val endAt: Int)

/**
 * Finds a `$$` on line [start], outside inline code and not escaped, and its closing `$$` on the
 * same line or a later one before the next blank line. Null when there is none, so an unbalanced
 * `$$` stays literal text.
 */
private fun findDisplayMath(lines: List<String>, start: Int): DisplayMath? {
  val first = lines[start]
  var at = 0
  var open = -1
  while (at < first.length) {
    val c = first[at]
    when {
      c == '\\' -> at += 2
      c == '`' -> {
        val end = first.indexOf('`', at + 1)
        at = if (end < 0) at + 1 else end + 1
      }
      first.startsWith("$$", at) -> { open = at; break }
      else -> at++
    }
  }
  if (open < 0) return null
  val latex = StringBuilder()
  var line = start
  var col = open + 2
  while (line < lines.size) {
    val text = lines[line]
    if (line > start && text.isBlank()) return null
    while (col < text.length) {
      if (text[col] == '\\') { latex.append(text, col, minOf(col + 2, text.length)); col += 2; continue }
      if (text.startsWith("$$", col)) {
        val body = latex.toString().trim()
        return if (body.isEmpty()) null else DisplayMath(open, body, line, col + 2)
      }
      latex.append(text[col++])
    }
    latex.append('\n')
    line++
    col = 0
  }
  return null
}

/** Image embeds in [text] that are not inside inline code, in order. */
private fun findImages(text: String): List<Pair<IntRange, MdBlock.Image>> {
  if ('!' !in text) return emptyList()
  val code = codeRanges(text)
  val found = mutableListOf<Pair<IntRange, MdBlock.Image>>()
  for (m in IMAGE_WIKI.findAll(text)) {
    val target = m.groupValues[1].trim()
    if (target.substringAfterLast('.', "").lowercase() in IMAGE_EXTENSIONS) found += m.range to MdBlock.Image(target)
  }
  for (m in IMAGE_MD.findAll(text)) {
    found += m.range to MdBlock.Image(m.groupValues[2].removeSurrounding("<", ">").trim(), m.groupValues[1].trim())
  }
  return found.filter { (range, _) -> code.none { range.first in it } }.sortedBy { it.first.first }
}

/** Index ranges of backtick code spans. */
private fun codeRanges(text: String): List<IntRange> {
  val ranges = mutableListOf<IntRange>()
  var at = text.indexOf('`')
  while (at >= 0) {
    val end = text.indexOf('`', at + 1)
    if (end < 0) break
    ranges += at..end
    at = text.indexOf('`', end + 1)
  }
  return ranges
}

private val LINK = Regex("!?\\[([^\\]]*)]\\([^)]*\\)")
private val WIKILINK = Regex("!?\\[\\[([^\\]|]*)(?:\\|([^\\]]*))?]]")

/**
 * Inline pass: `code`, **bold**, *italic*, ==mark==, `$math$`; links and wikilinks collapse to
 * their text. `\$` is a literal dollar.
 */
fun parseInline(raw: String): List<MdInline> {
  val text = collapseLinks(raw)
  val spans = mutableListOf<MdInline>()
  val buffer = StringBuilder()
  var bold = false
  var italic = false
  var mark = false
  fun flush() {
    if (buffer.isNotEmpty()) spans += MdSpan(buffer.toString(), bold, italic, mark = mark)
    buffer.clear()
  }
  var i = 0
  while (i < text.length) {
    val c = text[i]
    val pair = if (i + 1 < text.length) text.substring(i, i + 2) else ""
    when {
      pair == "\\$" -> { buffer.append('$'); i += 2 }
      c == '`' -> {
        val end = text.indexOf('`', i + 1)
        if (end < 0) { buffer.append(c); i++ } else {
          flush()
          spans += MdSpan(text.substring(i + 1, end), code = true)
          i = end + 1
        }
      }
      c == '$' -> {
        val math = matchMath(text, i)
        if (math == null) {
          // A `$$` that opens nothing stays as two literal dollars rather than retrying the second.
          val literal = if (pair == "$$") 2 else 1
          buffer.append(text, i, i + literal)
          i += literal
        } else {
          flush()
          spans += MdMath(math.first)
          i = math.second
        }
      }
      pair == "**" || pair == "__" -> { flush(); bold = !bold; i += 2 }
      pair == "==" -> { flush(); mark = !mark; i += 2 }
      (c == '*' || c == '_') && isEmphasisEdge(text, i) -> { flush(); italic = !italic; i++ }
      else -> { buffer.append(c); i++ }
    }
  }
  flush()
  return spans
}

/** Links and wikilinks reduced to their text, except inside inline code, which stays as written. */
private fun collapseLinks(raw: String): String {
  fun collapse(part: String) = WIKILINK.replace(LINK.replace(part) { it.groupValues[1] }) { m ->
    m.groupValues[2].ifEmpty { m.groupValues[1] }
  }
  val out = StringBuilder()
  var from = 0
  for (code in codeRanges(raw)) {
    out.append(collapse(raw.substring(from, code.first))).append(raw, code.first, code.last + 1)
    from = code.last + 1
  }
  return out.append(collapse(raw.substring(from))).toString()
}

/**
 * Math opening at [at], following Pandoc's rules so that prices are not formulas: the opening `$`
 * is followed by a non-space; the formula ends at the first unescaped `$`, which must follow a
 * non-space and must not be followed by a digit. A `$$` pair on the same run is math too. Returns
 * the LaTeX source and the index after the closing delimiter, or null when this `$` is literal.
 */
private fun matchMath(text: String, at: Int): Pair<String, Int>? {
  val display = text.startsWith("$$", at)
  val delimiter = if (display) "$$" else "$"
  val from = at + delimiter.length
  if (from >= text.length || text[from].isWhitespace()) return if (display) matchDisplayRun(text, from) else null
  var j = from
  while (j < text.length) {
    when {
      text[j] == '\\' -> j += 2
      text[j] == '`' -> return null
      text.startsWith(delimiter, j) -> {
        if (display) return text.substring(from, j).trim().takeIf { it.isNotEmpty() }?.let { it to j + 2 }
        val valid = !text[j - 1].isWhitespace() && text.getOrNull(j + 1)?.isDigit() != true
        return if (valid) text.substring(from, j) to j + 1 else null
      }
      else -> j++
    }
  }
  return null
}

/** `$$ x $$` inside a list item or heading: display delimiters allow spaces inside. */
private fun matchDisplayRun(text: String, from: Int): Pair<String, Int>? {
  var j = from
  while (j < text.length) {
    when {
      text[j] == '\\' -> j += 2
      text[j] == '`' -> return null
      text.startsWith("$$", j) -> return text.substring(from, j).trim().takeIf { it.isNotEmpty() }?.let { it to j + 2 }
      else -> j++
    }
  }
  return null
}

/** A lone * or _ toggles italics only at a word edge, so snake_case and 2*3 stay literal. */
private fun isEmphasisEdge(text: String, at: Int): Boolean {
  val before = text.getOrNull(at - 1)
  val after = text.getOrNull(at + 1)
  val opens = (before == null || !before.isLetterOrDigit()) && after != null && !after.isWhitespace()
  val closes = (after == null || !after.isLetterOrDigit()) && before != null && !before.isWhitespace()
  return opens || closes
}
