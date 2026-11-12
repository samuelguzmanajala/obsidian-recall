package com.recall.voice.ui

/** Small Markdown subset for card sides: paragraphs, headings, lists, fenced code and inline emphasis. */
sealed interface MdBlock {
  data class Paragraph(val spans: List<MdSpan>) : MdBlock
  data class Heading(val spans: List<MdSpan>) : MdBlock
  data class Item(val marker: String, val depth: Int, val spans: List<MdSpan>) : MdBlock
  data class Code(val text: String) : MdBlock
}

data class MdSpan(
  val text: String,
  val bold: Boolean = false,
  val italic: Boolean = false,
  val code: Boolean = false,
  val mark: Boolean = false,
)

private val FENCE = Regex("^\\s*(```|~~~)")
private val HEADING = Regex("^#{1,6}\\s+(.*)$")
private val BULLET = Regex("^(\\s*)[-*+]\\s+(.*)$")
private val ORDERED = Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$")

fun parseMarkdown(source: String): List<MdBlock> {
  val blocks = mutableListOf<MdBlock>()
  val paragraph = mutableListOf<String>()
  fun flush() {
    if (paragraph.isNotEmpty()) blocks += MdBlock.Paragraph(parseInline(paragraph.joinToString(" ")))
    paragraph.clear()
  }
  val lines = source.replace("\r\n", "\n").split('\n')
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
      else -> paragraph += line.trim()
    }
    i++
  }
  flush()
  return blocks
}

private val LINK = Regex("!?\\[([^\\]]*)]\\([^)]*\\)")
private val WIKILINK = Regex("!?\\[\\[([^\\]|]*)(?:\\|([^\\]]*))?]]")

/** Inline pass: `code`, **bold**, *italic*, ==mark==; links and wikilinks collapse to their text. */
fun parseInline(raw: String): List<MdSpan> {
  val text = WIKILINK.replace(LINK.replace(raw) { it.groupValues[1] }) { m ->
    m.groupValues[2].ifEmpty { m.groupValues[1] }
  }
  val spans = mutableListOf<MdSpan>()
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
      c == '`' -> {
        val end = text.indexOf('`', i + 1)
        if (end < 0) { buffer.append(c); i++ } else {
          flush()
          spans += MdSpan(text.substring(i + 1, end), code = true)
          i = end + 1
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

/** A lone * or _ toggles italics only at a word edge, so snake_case and 2*3 stay literal. */
private fun isEmphasisEdge(text: String, at: Int): Boolean {
  val before = text.getOrNull(at - 1)
  val after = text.getOrNull(at + 1)
  val opens = (before == null || !before.isLetterOrDigit()) && after != null && !after.isWhitespace()
  val closes = (after == null || !after.isLetterOrDigit()) && before != null && !before.isWhitespace()
  return opens || closes
}
