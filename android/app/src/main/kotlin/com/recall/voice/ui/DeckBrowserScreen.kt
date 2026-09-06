package com.recall.voice.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.recall.voice.api.DeckTreeNode
import com.recall.voice.api.RecallApi
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

private data class DeckRow(val node: DeckTreeNode, val depth: Int)

/** Render only nodes whose ancestors are all expanded. */
private fun visibleRows(
  nodes: List<DeckTreeNode>,
  collapsed: Set<String>,
  depth: Int = 0,
): List<DeckRow> =
  nodes.flatMap { node ->
    listOf(DeckRow(node, depth)) +
      if (node.id in collapsed || node.children.isEmpty()) emptyList()
      else visibleRows(node.children, collapsed, depth + 1)
  }

/** All deck IDs that have at least one child — i.e., the ones that can be collapsed. */
private fun collapsibleIds(nodes: List<DeckTreeNode>): Set<String> {
  val out = mutableSetOf<String>()
  fun walk(node: DeckTreeNode) {
    if (node.children.isNotEmpty()) out.add(node.id)
    node.children.forEach(::walk)
  }
  nodes.forEach(::walk)
  return out
}

@Composable
fun DeckBrowserScreen(
  api: RecallApi,
  onOpenSettings: () -> Unit,
  onStartSession: (deckId: String?) -> Unit,
  recoverReviews: suspend () -> Unit = {},
  rejectedReviewCount: () -> Int = { 0 },
) {
  var loading by remember { mutableStateOf(true) }
  var error by remember { mutableStateOf<String?>(null) }
  var decks by remember { mutableStateOf<List<DeckTreeNode>>(emptyList()) }
  var refreshTick by remember { mutableStateOf(0) }
  var rejected by remember { mutableStateOf(0) }

  // Collapse state — tracks which deck IDs are currently collapsed.
  // First time we see a deck with children, we add it to `collapsed` so the
  // initial view is fully collapsed. User toggles persist across refreshes.
  val collapsed = remember { mutableStateOf<Set<String>>(emptySet()) }
  val seen = remember { mutableStateOf<Set<String>>(emptySet()) }

  val lifecycleOwner = LocalLifecycleOwner.current
  LaunchedEffect(api, refreshTick, lifecycleOwner) {
    lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
      while (true) {
        loading = decks.isEmpty()
        try {
          recoverReviews()
          val updated = api.getDecks()
          decks = updated
          error = null
          val allCollapsibles = collapsibleIds(updated)
          val newOnes = allCollapsibles - seen.value
          collapsed.value = collapsed.value + newOnes
          seen.value = seen.value + allCollapsibles
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message ?: "Network error" }
        finally { loading = false; rejected = runCatching { rejectedReviewCount() }.getOrDefault(rejected) }
        delay(10_000)
      }
    }
  }

  Column(modifier = Modifier.fillMaxSize()) {
    Header(
      onOpenSettings = onOpenSettings,
      onRefresh = { refreshTick++ },
    )
    if (rejected > 0) Text("$rejected repasos rechazados por el servidor, no aplicados. Sus decisiones se conservan en el registro local.", modifier = Modifier.padding(16.dp))
    if (error != null && decks.isNotEmpty()) {
      Text("Sin conexión: los datos pueden estar desactualizados. Usa Refresh para reintentar.",
        modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
    }

    when {
      loading -> CenteredLoading()
      error != null && decks.isEmpty() -> CenteredError(error!!, onRetry = { refreshTick++ })
      decks.isEmpty() -> CenteredEmpty()
      else -> DeckList(
        decks = decks,
        collapsed = collapsed.value,
        onToggle = { id ->
          collapsed.value = if (id in collapsed.value) collapsed.value - id
            else collapsed.value + id
        },
        onStartSession = onStartSession,
      )
    }
  }
}

@Composable
private fun Header(onOpenSettings: () -> Unit, onRefresh: () -> Unit) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text("Recall Voice", style = MaterialTheme.typography.titleLarge)
    Box(modifier = Modifier.weight(1f))
    IconButton(onClick = onRefresh) {
      Icon(Icons.Default.Refresh, contentDescription = "Refresh")
    }
    IconButton(onClick = onOpenSettings) {
      Icon(Icons.Default.Settings, contentDescription = "Settings")
    }
  }
  HorizontalDivider()
}

@Composable
private fun DeckList(
  decks: List<DeckTreeNode>,
  collapsed: Set<String>,
  onToggle: (String) -> Unit,
  onStartSession: (String?) -> Unit,
) {
  val totalDue = decks.sumOf { it.dueItems }
  val totalNew = decks.sumOf { it.newItems }
  val totalAll = decks.sumOf { it.totalItems }

  LazyColumn(
    modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    item {
      Box(modifier = Modifier.padding(top = 8.dp)) {
        AllDecksCard(
          due = totalDue,
          new_ = totalNew,
          total = totalAll,
          onClick = { onStartSession(null) },
        )
      }
    }
    item {
      Text(
        "Decks",
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
      )
    }
    items(visibleRows(decks, collapsed), key = { row -> row.node.id }) { row ->
      DeckRowItem(
        node = row.node,
        depth = row.depth,
        isCollapsed = row.node.id in collapsed,
        onToggle = { onToggle(row.node.id) },
        onClick = { onStartSession(row.node.id) },
      )
    }
    item { Box(modifier = Modifier.padding(8.dp)) {} }
  }
}

@Composable
private fun AllDecksCard(due: Int, new_: Int, total: Int, onClick: () -> Unit) {
  Card(
    modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    shape = RoundedCornerShape(12.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(modifier = Modifier.weight(1f)) {
        Text("Estudiar todo", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(
          "$due due · $new_ new · $total total",
          style = MaterialTheme.typography.bodyMedium,
        )
      }
      Text("→", fontSize = 28.sp)
    }
  }
}

@Composable
private fun DeckRowItem(
  node: DeckTreeNode,
  depth: Int,
  isCollapsed: Boolean,
  onToggle: () -> Unit,
  onClick: () -> Unit,
) {
  val hasChildren = node.children.isNotEmpty()
  val indent = (depth * 16).dp
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(8.dp))
      .clickable(onClick = onClick)
      .background(MaterialTheme.colorScheme.surfaceVariant)
      .padding(start = 4.dp + indent, top = 4.dp, bottom = 4.dp, end = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (hasChildren) {
      IconButton(onClick = onToggle, modifier = Modifier.size(32.dp)) {
        Icon(
          imageVector = if (isCollapsed) Icons.Default.ChevronRight else Icons.Default.ExpandMore,
          contentDescription = if (isCollapsed) "Expandir" else "Colapsar",
        )
      }
    } else {
      Spacer(modifier = Modifier.width(32.dp))
    }
    Text(
      text = node.name,
      style = MaterialTheme.typography.bodyLarge,
      modifier = Modifier.weight(1f).padding(start = 4.dp),
    )
    Counts(due = node.dueItems, new_ = node.newItems, total = node.totalItems)
  }
}

@Composable
private fun Counts(due: Int, new_: Int, total: Int) {
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    if (due > 0) Text(due.toString(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    if (new_ > 0) Text(new_.toString(), color = MaterialTheme.colorScheme.tertiary, style = MaterialTheme.typography.bodyMedium)
    Text(total.toString(), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
  }
}

@Composable
private fun CenteredLoading() {
  Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    CircularProgressIndicator()
  }
}

@Composable
private fun CenteredError(message: String, onRetry: () -> Unit) {
  Column(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text("No se pudo cargar la lista de decks.", style = MaterialTheme.typography.titleMedium)
    Text(
      message,
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.error,
      modifier = Modifier.padding(vertical = 8.dp),
    )
    TextButton(onClick = onRetry) { Text("Reintentar") }
  }
}

@Composable
private fun CenteredEmpty() {
  Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text("Sin decks. Crea cards en Obsidian primero.")
  }
}
