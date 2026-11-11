package com.recall.voice.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.recall.voice.R
import com.recall.voice.api.DeckTreeNode
import com.recall.voice.api.RecallApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * One visible row of the deck tree, with what the transit line needs to draw it.
 *
 * [rails] has one entry per ancestor column (0 until depth): whether the line at that column
 * continues below this row. The column at depth - 1 always reaches up to this row's station.
 */
internal data class DeckRow(
  val node: DeckTreeNode,
  val depth: Int,
  val rails: List<Boolean>,
  /** Root rows only: there is a root above this one, so the trunk comes in from the top. */
  val trunkAbove: Boolean,
  /** Root rows only: there is a root below this one, so the trunk leaves through the bottom. */
  val trunkBelow: Boolean,
  /** Children of this node are visible right below it. */
  val expanded: Boolean,
)

/** Render only nodes whose ancestors are all expanded, with the line segments each row needs. */
internal fun visibleRows(
  nodes: List<DeckTreeNode>,
  collapsed: Set<String>,
): List<DeckRow> {
  val out = mutableListOf<DeckRow>()
  fun walk(node: DeckTreeNode, depth: Int, rails: List<Boolean>, trunkAbove: Boolean, trunkBelow: Boolean) {
    val expanded = node.children.isNotEmpty() && node.id !in collapsed
    out += DeckRow(node, depth, rails, trunkAbove, trunkBelow, expanded)
    if (!expanded) return
    node.children.forEachIndexed { i, child ->
      // The column of this node carries on past the child while more children follow, and, for a
      // root, while the trunk still has to reach the next root.
      val continues = i < node.children.lastIndex || (depth == 0 && trunkBelow)
      walk(child, depth + 1, rails + continues, trunkAbove = false, trunkBelow = false)
    }
  }
  nodes.forEachIndexed { i, root -> walk(root, 0, emptyList(), i > 0, i < nodes.lastIndex) }
  return out
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
  onStartSession: (deckId: String?, deckName: String) -> Unit,
  recoverReviews: suspend () -> Unit = {},
  rejectedReviewCount: () -> Int = { 0 },
) {
  var loading by remember { mutableStateOf(true) }
  var refreshing by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var decks by remember { mutableStateOf<List<DeckTreeNode>>(emptyList()) }
  var refreshTick by remember { mutableIntStateOf(0) }
  var rejected by remember { mutableIntStateOf(0) }

  // Collapse state — tracks which deck IDs are currently collapsed.
  // First time we see a deck with children, we add it to `collapsed` so the
  // initial view is fully collapsed. User toggles persist across refreshes.
  var collapsed by remember { mutableStateOf<Set<String>>(emptySet()) }
  var seen by remember { mutableStateOf<Set<String>>(emptySet()) }

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
          collapsed = collapsed + (allCollapsibles - seen)
          seen = seen + allCollapsibles
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message.orEmpty() }
        finally {
          loading = false
          refreshing = false
          rejected = runCatching { rejectedReviewCount() }.getOrDefault(rejected)
        }
        delay(10_000)
      }
    }
  }

  DeckBrowserContent(
    decks = decks,
    loading = loading,
    refreshing = refreshing,
    error = error,
    rejected = rejected,
    collapsed = collapsed,
    onToggle = { id -> collapsed = if (id in collapsed) collapsed - id else collapsed + id },
    onRefresh = { refreshing = true; refreshTick++ },
    onRetry = { refreshTick++ },
    onOpenSettings = onOpenSettings,
    onStartSession = onStartSession,
  )
}

/** Width of a tabular count column, shared by the column heads and the rows. */
private val CountColumn = 64.dp

/** Horizontal step between tree levels. */
private val Indent = 20.dp

/** Centre of the line's first column, measured from the row's start edge. */
private val GutterStart = 24.dp

/**
 * The home screen as plain state, so it can be rendered without a network.
 *
 * [error] is non-null when the last load failed (an empty string when the failure had no message).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeckBrowserContent(
  decks: List<DeckTreeNode>,
  loading: Boolean,
  refreshing: Boolean,
  error: String?,
  rejected: Int,
  collapsed: Set<String>,
  onToggle: (String) -> Unit,
  onRefresh: () -> Unit,
  onRetry: () -> Unit,
  onOpenSettings: () -> Unit,
  onStartSession: (deckId: String?, deckName: String) -> Unit,
) {
  Scaffold(
    topBar = {
      ShellTopBar(
        title = stringResource(R.string.app_name),
        actions = {
          IconButton(onClick = onRefresh) {
            Icon(Icons.Filled.Refresh, stringResource(R.string.action_refresh))
          }
          IconButton(onClick = onOpenSettings) {
            Icon(Icons.Filled.Settings, stringResource(R.string.action_settings))
          }
        },
      )
    },
  ) { insets ->
    PullToRefreshBox(
      isRefreshing = refreshing,
      onRefresh = onRefresh,
      modifier = Modifier.fillMaxSize().padding(insets),
    ) {
      when {
        loading -> LoadingSkeleton()
        error != null && decks.isEmpty() -> ErrorState(error, onRetry, onOpenSettings)
        decks.isEmpty() -> EmptyState()
        else -> DeckList(
          decks = decks,
          stale = error != null,
          rejected = rejected,
          collapsed = collapsed,
          onToggle = onToggle,
          onStartSession = onStartSession,
        )
      }
    }
  }
}

@Composable
private fun DeckList(
  decks: List<DeckTreeNode>,
  stale: Boolean,
  rejected: Int,
  collapsed: Set<String>,
  onToggle: (String) -> Unit,
  onStartSession: (String?, String) -> Unit,
) {
  val totalDue = decks.sumOf { it.dueItems }
  val totalNew = decks.sumOf { it.newItems }
  val totalAll = decks.sumOf { it.totalItems }
  val allDecks = stringResource(R.string.home_all_decks)
  val rows = remember(decks, collapsed) { visibleRows(decks, collapsed) }

  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(bottom = 24.dp),
  ) {
    item(key = "summary") {
      Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 8.dp)) {
        Text(
          if (totalDue == 0) stringResource(R.string.home_due_title_zero)
          else pluralStringResource(R.plurals.home_due_title, totalDue, totalDue),
          style = MaterialTheme.typography.headlineMedium,
          color = MaterialTheme.colorScheme.onBackground,
          modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(4.dp))
        Text(
          stringResource(R.string.home_due_detail, totalNew, totalAll),
          style = MaterialTheme.typography.bodyLarge,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        Button(
          onClick = { onStartSession(null, allDecks) },
          shape = MaterialTheme.shapes.large,
          modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
        ) { Text(stringResource(R.string.home_start_all), style = MaterialTheme.typography.titleMedium) }
      }
    }
    if (rejected > 0) item(key = "rejected") {
      Banner(
        icon = Icons.Filled.ErrorOutline,
        text = pluralStringResource(R.plurals.home_rejected, rejected, rejected),
        container = MaterialTheme.colorScheme.errorContainer,
        content = MaterialTheme.colorScheme.onErrorContainer,
      )
    }
    if (stale) item(key = "stale") {
      Banner(
        icon = Icons.Filled.CloudOff,
        text = stringResource(R.string.home_stale),
        container = MaterialTheme.colorScheme.surfaceContainer,
        content = MaterialTheme.colorScheme.onSurface,
      )
    }
    item(key = "heads") { ColumnHeads() }
    items(rows, key = { row -> row.node.id }) { row ->
      DeckRowItem(
        row = row,
        onToggle = { onToggle(row.node.id) },
        onClick = { onStartSession(row.node.id, row.node.name) },
      )
    }
  }
}

@Composable
private fun Banner(
  icon: ImageVector,
  text: String,
  container: androidx.compose.ui.graphics.Color,
  content: androidx.compose.ui.graphics.Color,
) {
  Surface(
    color = container,
    contentColor = content,
    shape = MaterialTheme.shapes.medium,
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
  ) {
    Row(
      Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Icon(icon, contentDescription = null)
      Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
  }
}

@Composable
private fun ColumnHeads() {
  Row(
    Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 24.dp, bottom = 4.dp),
    verticalAlignment = Alignment.Bottom,
  ) {
    Text(
      stringResource(R.string.home_decks),
      style = MaterialTheme.typography.titleMedium,
      color = MaterialTheme.colorScheme.onBackground,
      modifier = Modifier.weight(1f).semantics { heading() },
    )
    for (head in listOf(R.string.home_col_due, R.string.home_col_new)) {
      Text(
        stringResource(head).uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.End,
        maxLines = 1,
        modifier = Modifier.width(CountColumn).clearAndSetSemantics {},
      )
    }
  }
}

@Composable
private fun DeckRowItem(row: DeckRow, onToggle: () -> Unit, onClick: () -> Unit) {
  val node = row.node
  val description = stringResource(R.string.home_deck_row, node.name, node.dueItems, node.newItems)
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .heightIn(min = 56.dp)
      .clickable(role = Role.Button, onClick = onClick)
      .semantics(mergeDescendants = true) { contentDescription = description }
      .transitLine(row)
      .padding(start = GutterStart + Indent * row.depth + 12.dp, end = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (node.children.isNotEmpty()) {
      val label = stringResource(if (row.expanded) R.string.home_collapse else R.string.home_expand, node.name)
      IconButton(onClick = onToggle) {
        Icon(
          if (row.expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = label,
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    } else {
      Spacer(Modifier.width(12.dp))
    }
    Text(
      node.name,
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurface,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f).padding(vertical = 8.dp).clearAndSetSemantics {},
    )
    Count(node.dueItems)
    Count(node.newItems)
  }
}

@Composable
private fun Count(value: Int) {
  Text(
    value.toString(),
    style = if (value > 0) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
    color = if (value > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline,
    textAlign = TextAlign.End,
    maxLines = 1,
    modifier = Modifier.width(CountColumn).clearAndSetSemantics {},
  )
}

/**
 * The deck tree as a branching line: a station at each row, joined to its parent by
 * right-angled segments, with ancestor lines running on past rows that still have siblings below.
 */
@Composable
private fun Modifier.transitLine(row: DeckRow): Modifier {
  val track = MaterialTheme.colorScheme.outlineVariant
  val station = MaterialTheme.colorScheme.onSurface
  val ring = MaterialTheme.colorScheme.background
  return drawBehind {
    val stroke = 4.dp.toPx()
    val mid = size.height / 2
    fun x(column: Int): Float {
      val fromStart = (GutterStart + Indent * column).toPx()
      return if (layoutDirection == androidx.compose.ui.unit.LayoutDirection.Rtl) size.width - fromStart else fromStart
    }
    fun vertical(column: Int, top: Float, bottom: Float) =
      drawLine(track, Offset(x(column), top), Offset(x(column), bottom), stroke, StrokeCap.Round)

    val d = row.depth
    // Ancestor columns that run straight through this row.
    for (c in 0 until d - 1) if (row.rails[c]) vertical(c, 0f, size.height)
    if (d > 0) {
      // Elbow from the parent's column into this station, continuing down if siblings follow.
      vertical(d - 1, 0f, if (row.rails[d - 1]) size.height else mid)
      drawLine(track, Offset(x(d - 1), mid), Offset(x(d), mid), stroke, StrokeCap.Round)
    } else {
      if (row.trunkAbove) vertical(0, 0f, mid)
      if (row.trunkBelow) vertical(0, mid, size.height)
    }
    // Down to this deck's first child.
    if (row.expanded) vertical(d, mid, size.height)

    val at = Offset(x(d), mid)
    if (d == 0) {
      // Roots are interchanges: a ring rather than a plain stop.
      drawCircle(station, 8.dp.toPx(), at)
      drawCircle(ring, 4.dp.toPx(), at)
    } else {
      drawCircle(ring, 7.dp.toPx(), at)
      drawCircle(station, 5.dp.toPx(), at)
    }
  }
}

@Composable
private fun LoadingSkeleton() {
  val description = stringResource(R.string.home_loading)
  val pulse by rememberInfiniteTransition(label = "skeleton").animateFloat(
    initialValue = 0.55f,
    targetValue = 1f,
    animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
    label = "pulse",
  )
  val block = MaterialTheme.colorScheme.surfaceContainer
  Column(
    Modifier
      .fillMaxSize()
      .alpha(pulse)
      .clearAndSetSemantics { contentDescription = description }
      .padding(top = 24.dp),
  ) {
    Column(Modifier.padding(horizontal = 20.dp)) {
      SkeletonBar(0.7f, 32.dp)
      Spacer(Modifier.height(10.dp))
      SkeletonBar(0.45f, 18.dp)
      Spacer(Modifier.height(20.dp))
      Box(Modifier.fillMaxWidth().height(64.dp).background(block, MaterialTheme.shapes.large))
    }
    Spacer(Modifier.height(36.dp))
    val widths = listOf(0.55f, 0.4f, 0.62f, 0.35f, 0.5f, 0.44f)
    widths.forEachIndexed { i, w ->
      Row(
        Modifier.fillMaxWidth().height(56.dp).padding(start = 16.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Box(Modifier.padding(start = if (i % 3 == 0) 0.dp else Indent).size(16.dp).background(block, MaterialTheme.shapes.extraLarge))
        Spacer(Modifier.width(20.dp))
        Box(Modifier.weight(1f)) { SkeletonBar(w, 18.dp) }
        Box(Modifier.width(CountColumn), contentAlignment = Alignment.CenterEnd) { SkeletonBar(0.5f, 18.dp) }
        Box(Modifier.width(CountColumn), contentAlignment = Alignment.CenterEnd) { SkeletonBar(0.5f, 18.dp) }
      }
    }
  }
}

@Composable
private fun SkeletonBar(fraction: Float, height: Dp) {
  Box(
    Modifier
      .fillMaxWidth(fraction)
      .height(height)
      .background(MaterialTheme.colorScheme.surfaceContainer, MaterialTheme.shapes.extraSmall),
  )
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit, onOpenSettings: () -> Unit) {
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
  ) {
    Icon(Icons.Filled.CloudOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(
      stringResource(R.string.home_error_title),
      style = MaterialTheme.typography.headlineMedium,
      color = MaterialTheme.colorScheme.onBackground,
      modifier = Modifier.semantics { heading() },
    )
    Text(
      message.ifBlank { stringResource(R.string.home_error_unknown) },
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(8.dp))
    Button(
      onClick = onRetry,
      shape = MaterialTheme.shapes.large,
      modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) { Text(stringResource(R.string.action_retry), style = MaterialTheme.typography.titleMedium) }
    OutlinedButton(
      onClick = onOpenSettings,
      shape = MaterialTheme.shapes.large,
      modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
    ) { Text(stringResource(R.string.home_open_settings), style = MaterialTheme.typography.titleMedium) }
  }
}

@Composable
private fun EmptyState() {
  // Scrollable so pull-to-refresh still works when there is nothing to list.
  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
  ) {
    Text(
      stringResource(R.string.home_empty_title),
      style = MaterialTheme.typography.headlineMedium,
      color = MaterialTheme.colorScheme.onBackground,
      modifier = Modifier.semantics { heading() },
    )
    Text(
      stringResource(R.string.home_empty_body),
      style = MaterialTheme.typography.bodyLarge,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}
