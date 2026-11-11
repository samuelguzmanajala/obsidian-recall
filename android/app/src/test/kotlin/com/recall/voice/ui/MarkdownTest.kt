package com.recall.voice.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class MarkdownTest {
  @Test fun `paragraph lines join and blank lines split`() {
    val blocks = parseMarkdown("uno\ndos\n\ntres")
    assertEquals(
      listOf(MdBlock.Paragraph(listOf(MdSpan("uno dos"))), MdBlock.Paragraph(listOf(MdSpan("tres")))),
      blocks,
    )
  }

  @Test fun `inline emphasis code and mark`() {
    assertEquals(
      listOf(
        MdSpan("a "), MdSpan("b", bold = true), MdSpan(" "), MdSpan("c", italic = true),
        MdSpan(" "), MdSpan("d_e", code = true), MdSpan(" "), MdSpan("f", mark = true),
      ),
      parseInline("a **b** *c* `d_e` ==f=="),
    )
  }

  @Test fun `snake case and arithmetic stay literal`() {
    assertEquals(listOf(MdSpan("user_id = 2*3")), parseInline("user_id = 2*3"))
  }

  @Test fun `links and wikilinks collapse to their text`() {
    assertEquals(listOf(MdSpan("ver Kant y ética")), parseInline("ver [Kant](https://x.y) y [[notas/etica|ética]]"))
  }

  @Test fun `lists headings and fenced code`() {
    val blocks = parseMarkdown("# Título\n- uno\n  - dos\n1. tres\n```kotlin\nval a = 1\n```")
    assertEquals(
      listOf(
        MdBlock.Heading(listOf(MdSpan("Título"))),
        MdBlock.Item("•", 0, listOf(MdSpan("uno"))),
        MdBlock.Item("•", 1, listOf(MdSpan("dos"))),
        MdBlock.Item("1.", 0, listOf(MdSpan("tres"))),
        MdBlock.Code("val a = 1"),
      ),
      blocks,
    )
  }

  @Test fun `unterminated fence keeps the code`() {
    assertEquals(listOf(MdBlock.Code("a\nb")), parseMarkdown("```\na\nb"))
  }
}
