package com.recall.voice.ui

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Nested
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

  @Nested inner class Math {
    @Test fun `real inline formulas from cards`() {
      assertEquals(
        listOf(MdMath("\\bar{x}=\\frac{\\sum_{i=1}^n{x_i}}{n}")),
        parseInline("\$\\bar{x}=\\frac{\\sum_{i=1}^n{x_i}}{n}\$"),
      )
      assertEquals(
        listOf(MdMath("\\bar{x}_w=\\frac{\\sum_{i=1}^nW_{i}X_i}{\\sum_{i=1}^nW_{i}}")),
        parseInline("\$\\bar{x}_w=\\frac{\\sum_{i=1}^nW_{i}X_i}{\\sum_{i=1}^nW_{i}}\$"),
      )
      assertEquals(
        listOf(MdSpan("¿por qué se divide entre "), MdMath("n-2p"), MdSpan("?")),
        parseInline("¿por qué se divide entre \$n-2p\$?"),
      )
      assertEquals(
        listOf(MdSpan("eliminar un número fijo "), MdMath("p"), MdSpan(" de valores")),
        parseInline("eliminar un número fijo \$p\$ de valores"),
      )
      assertEquals(
        listOf(MdSpan("Características (Features / "), MdMath("X"), MdSpan(")")),
        parseInline("Características (Features / \$X\$)"),
      )
    }

    @Test fun `prices are not math`() {
      assertEquals(listOf(MdSpan("Cuesta \$5 y \$10")), parseInline("Cuesta \$5 y \$10"))
      assertEquals(listOf(MdSpan("de \$5 a \$10.")), parseInline("de \$5 a \$10."))
    }

    @Test fun `a closing dollar followed by a digit or after a space closes nothing`() {
      assertEquals(listOf(MdSpan("\$x\$5")), parseInline("\$x\$5"))
      assertEquals(listOf(MdSpan("\$x \$")), parseInline("\$x \$"))
      assertEquals(listOf(MdSpan("\$ x\$")), parseInline("\$ x\$"))
    }

    @Test fun `escaped dollars are literal`() {
      assertEquals(listOf(MdSpan("\$x\$")), parseInline("\\\$x\\\$"))
      assertEquals(listOf(MdSpan("son \$3 o "), MdMath("y")), parseInline("son \\\$3 o \$y\$"))
    }

    @Test fun `no math inside inline code`() {
      assertEquals(
        listOf(MdSpan("usa "), MdSpan("\$x\$", code = true), MdSpan(" aquí")),
        parseInline("usa `\$x\$` aquí"),
      )
      assertEquals(listOf(MdSpan("\$\$x\$\$", code = true)), parseInline("`\$\$x\$\$`"))
    }

    @Test fun `no math inside fenced code`() {
      assertEquals(listOf(MdBlock.Code("\$\$x\$\$\n\$y\$")), parseMarkdown("```\n\$\$x\$\$\n\$y\$\n```"))
    }

    @Test fun `unbalanced dollars stay literal`() {
      assertEquals(listOf(MdSpan("precio \$x sin cerrar")), parseInline("precio \$x sin cerrar"))
      assertEquals(listOf(MdBlock.Paragraph(listOf(MdSpan("a \$\$ b")))), parseMarkdown("a \$\$ b"))
      // A blank line ends a display formula that has not closed, so neither `$$` opens anything.
      assertEquals(
        listOf(MdBlock.Paragraph(listOf(MdSpan("\$\$ x"))), MdBlock.Paragraph(listOf(MdSpan("y \$\$")))),
        parseMarkdown("\$\$ x\n\ny \$\$"),
      )
    }

    @Test fun `underscores and stars inside math are not emphasis`() {
      assertEquals(
        listOf(MdMath("x_i"), MdSpan(" y "), MdMath("a*b"), MdSpan(" "), MdSpan("c", italic = true)),
        parseInline("\$x_i\$ y \$a*b\$ *c*"),
      )
    }

    @Test fun `display math spanning lines is its own block`() {
      assertEquals(
        listOf(
          MdBlock.Paragraph(listOf(MdSpan("La media recortada:"))),
          MdBlock.Math("\\bar{x}_t=\n\\frac{1}{n-2p}\\sum x_{(i)}"),
          MdBlock.Paragraph(listOf(MdSpan("Fin."))),
        ),
        parseMarkdown("La media recortada:\n\$\$\n\\bar{x}_t=\n\\frac{1}{n-2p}\\sum x_{(i)}\n\$\$\nFin."),
      )
    }

    @Test fun `display math on one line and inside a paragraph`() {
      assertEquals(listOf(MdBlock.Math("x^2")), parseMarkdown("\$\$x^2\$\$"))
      assertEquals(
        listOf(
          MdBlock.Paragraph(listOf(MdSpan("antes"))),
          MdBlock.Math("a+b"),
          MdBlock.Paragraph(listOf(MdSpan("después y "), MdMath("c"))),
        ),
        parseMarkdown("antes \$\$a+b\$\$ después y \$c\$"),
      )
    }

    @Test fun `display math in a list item stays inline`() {
      assertEquals(listOf(MdBlock.Item("•", 0, listOf(MdMath("x^2")))), parseMarkdown("- \$\$ x^2 \$\$"))
    }
  }

  @Nested inner class Images {
    @Test fun `wikilink image embeds are their own block`() {
      assertEquals(listOf(MdBlock.Image("grafico.png")), parseMarkdown("![[grafico.png]]"))
      val blocks = parseMarkdown("Mira ![[adjuntos/día 1.PNG|300]] aquí")
      assertEquals(
        listOf(
          MdBlock.Paragraph(listOf(MdSpan("Mira"))),
          MdBlock.Image("adjuntos/día 1.PNG"),
          MdBlock.Paragraph(listOf(MdSpan("aquí"))),
        ),
        blocks,
      )
      assertEquals("día 1.PNG", (blocks[1] as MdBlock.Image).fileName)
    }

    @Test fun `markdown images keep alt text and decode spaces`() {
      val image = parseMarkdown("![Diagrama](adjuntos/mi%20grafico.jpg)").single() as MdBlock.Image
      assertEquals(MdBlock.Image("adjuntos/mi%20grafico.jpg", "Diagrama"), image)
      assertEquals("mi grafico.jpg", image.fileName)
      assertEquals(MdBlock.Image("a b.png"), parseMarkdown("![](<a b.png>)").single())
    }

    @Test fun `embeds of notes collapse to text`() {
      assertEquals(listOf(MdBlock.Paragraph(listOf(MdSpan("ver nota")))), parseMarkdown("ver ![[nota]]"))
      assertEquals(listOf(MdBlock.Paragraph(listOf(MdSpan("informe.pdf")))), parseMarkdown("![[informe.pdf]]"))
    }

    @Test fun `image syntax inside code is left alone`() {
      assertEquals(
        listOf(MdBlock.Paragraph(listOf(MdSpan("![[a.png]]", code = true)))),
        parseMarkdown("`![[a.png]]`"),
      )
    }
  }
}
