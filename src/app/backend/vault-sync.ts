import { Container } from './container';
import { ParsedCard } from '@context/concept/infrastructure/markdown-parser';
import { FrontmatterParser } from '@context/concept/infrastructure/frontmatter-parser';
import { Directionality } from '@context/concept/domain/directionality';
import { Direction } from '@context/study/domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';
import { SerializedSyncState } from '@context/shared/infrastructure/json-storage';

/**
 * Tracks which concepts came from which file, so we can
 * detect additions, removals, and changes when a file is re-parsed.
 */
interface FileIndex {
  /** Map of "sideA|sideB|directionality" → conceptId */
  cardKeys: Map<string, string>;
  /** Map of conceptId → line number in the source file */
  conceptLines: Map<string, number>;
  /** studyItemIds created for this file */
  studyItemIds: string[];
  /** deckIds (leaf decks) assigned to this file's cards */
  deckIds: string[];
}

export class VaultSync {
  private fileIndices = new Map<string, FileIndex>();
  private frontmatterParser = new FrontmatterParser();
  /** tag → deckId — ensures same tag always maps to same deck */
  private tagToDeckId = new Map<string, string>();

  private static readonly UNTAGGED_DECK_TAG = '__untagged__';

  private batchMode = false;

  /** Tags the user configured in settings. Empty = allow all. */
  private allowedTags: string[] = [];

  constructor(private readonly container: Container) {}

  /**
   * Set which tags are allowed. Only notes with at least one matching tag
   * (or subtag) will be indexed. Empty array = index everything.
   */
  setAllowedTags(tags: string[]): void {
    this.allowedTags = tags;
  }

  /**
   * Wipe all sync state, decks, concepts, study items, and reviews.
   * Called when tag filter changes so we can rebuild from scratch.
   * Uses atomic clear() — one write per store, not per entity.
   */
  async resetAll(): Promise<void> {
    await this.container.deckRepository.clear();
    await this.container.conceptRepository.clear();
    await this.container.studyItemRepository.clear();
    await this.container.reviewLog.clear();

    // Clear in-memory maps
    this.fileIndices.clear();
    this.tagToDeckId.clear();

    // Persist empty sync state
    await this.persistState();
  }

  /**
   * Returns only the tags that match the allowed filter.
   * e.g. note has [dev, kafka, German] and allowed is [dev, German]
   * → returns [dev, German] (kafka excluded)
   */
  private filterToAllowedTags(noteTags: string[]): string[] {
    if (this.allowedTags.length === 0) return noteTags;
    return noteTags.filter(noteTag =>
      this.allowedTags.some(allowed =>
        noteTag === allowed || noteTag.startsWith(allowed + '/'),
      ),
    );
  }

  /**
   * Checks if a note's tags match the allowed filter.
   * A note tag "German/vocabulary" matches allowed tag "German".
   * Empty allowedTags = everything passes.
   */
  private matchesTagFilter(noteTags: string[]): boolean {
    if (this.allowedTags.length === 0) return true;
    return noteTags.some(noteTag =>
      this.allowedTags.some(allowed =>
        noteTag === allowed || noteTag.startsWith(allowed + '/'),
      ),
    );
  }

  /**
   * Find which file and line a concept belongs to.
   */
  findFileByConceptId(conceptId: string): { filePath: string; line: number } | null {
    for (const [filePath, index] of this.fileIndices) {
      for (const cid of index.cardKeys.values()) {
        if (cid === conceptId) {
          const line = index.conceptLines.get(conceptId) ?? 1;
          return { filePath, line };
        }
      }
    }
    return null;
  }

  /**
   * Must be called before the first syncFile to avoid duplicates on restart.
   */
  async initialize(): Promise<void> {
    const state = await this.container.syncStateFile.read<SerializedSyncState>();
    if (!state) return;

    for (const [tag, deckId] of Object.entries(state.tagToDeckId)) {
      this.tagToDeckId.set(tag, deckId);
    }

    for (const [filePath, serialized] of Object.entries(state.fileIndices)) {
      const index: FileIndex = {
        cardKeys: new Map(Object.entries(serialized.cardKeys)),
        conceptLines: new Map(Object.entries(serialized.conceptLines ?? {})),
        studyItemIds: serialized.studyItemIds,
        deckIds: serialized.deckIds,
      };
      this.fileIndices.set(filePath, index);
    }
  }

  /**
   * Sync a single file. Returns true if the file was indexed (had matching tags + cards).
   */
  async syncFile(filePath: string, content: string): Promise<boolean> {
    const parsedCards = this.container.parser.parse(content, filePath);
    const tags = this.frontmatterParser.extractTags(content);

    // If tag filter is active and note doesn't match, treat as removal
    if (!this.matchesTagFilter(tags)) {
      if (this.fileIndices.has(filePath)) {
        await this.removeFile(filePath);
      }
      return false;
    }

    if (parsedCards.length === 0) {
      // Matching tags but no cards — remove if previously indexed
      if (this.fileIndices.has(filePath)) {
        await this.removeFile(filePath);
      }
      return false;
    }

    const previousIndex = this.fileIndices.get(filePath);
    const newIndex: FileIndex = { cardKeys: new Map(), conceptLines: new Map(), studyItemIds: [], deckIds: [] };

    const previousKeys = new Set(previousIndex?.cardKeys.keys() ?? []);

    // Filter tags to only those matching the allowed filter
    // Files without matching tags go to "Untagged" deck
    const filteredTags = this.filterToAllowedTags(tags);
    const effectiveTags = filteredTags.length > 0 ? filteredTags : [VaultSync.UNTAGGED_DECK_TAG];
    const leafDeckIds = await this.ensureDeckHierarchy(effectiveTags);
    newIndex.deckIds = leafDeckIds;

    // Detect if deck assignments changed (tags were modified)
    const decksChanged = previousIndex
      ? !this.sameArrays(previousIndex.deckIds, leafDeckIds)
      : false;

    for (const card of parsedCards) {
      const key = this.cardKey(card);

      if (previousIndex?.cardKeys.has(key)) {
        // Card still exists — keep it
        const conceptId = previousIndex.cardKeys.get(key)!;
        newIndex.cardKeys.set(key, conceptId);
        newIndex.conceptLines.set(conceptId, card.lineNumber);
        previousKeys.delete(key);

        // If tags changed, reassign study items to new decks
        if (decksChanged) {
          const studyItems = await this.container.studyItemRepository.findByConceptId(
            new ConceptId(conceptId),
          );
          const siIds = studyItems.map(si => si.id.value);

          // Remove from old decks
          for (const oldDeckId of previousIndex!.deckIds) {
            for (const siId of siIds) {
              await this.container.removeStudyItemFromDeck.execute({
                deckId: oldDeckId,
                studyItemId: siId,
              });
            }
          }

          // Add to new decks
          for (const deckId of leafDeckIds) {
            for (const siId of siIds) {
              await this.container.addStudyItemToDeck.execute({
                deckId,
                studyItemId: siId,
              });
            }
          }

          newIndex.studyItemIds.push(...siIds);
        } else {
          // Decks didn't change — carry over studyItemIds
          const studyItems = await this.container.studyItemRepository.findByConceptId(
            new ConceptId(conceptId),
          );
          newIndex.studyItemIds.push(...studyItems.map(si => si.id.value));
        }
      } else {
        // New card — create concept + study items + assign to decks
        const { conceptId, studyItemIds } = await this.createConceptWithStudyItems(card);
        newIndex.cardKeys.set(key, conceptId);
        newIndex.conceptLines.set(conceptId, card.lineNumber);
        newIndex.studyItemIds.push(...studyItemIds);

        // Assign study items to leaf decks
        for (const deckId of leafDeckIds) {
          for (const siId of studyItemIds) {
            await this.container.addStudyItemToDeck.execute({
              deckId,
              studyItemId: siId,
            });
          }
        }
      }
    }

    // Remove cards that no longer exist in the file
    for (const removedKey of previousKeys) {
      const conceptId = previousIndex!.cardKeys.get(removedKey)!;
      await this.removeConceptWithStudyItems(conceptId, previousIndex!.deckIds);
    }

    this.fileIndices.set(filePath, newIndex);
    await this.persistState();
    return true;
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const index = this.fileIndices.get(oldPath);
    if (!index) return;

    this.fileIndices.delete(oldPath);
    this.fileIndices.set(newPath, index);
    await this.persistState();
  }

  async removeFile(filePath: string): Promise<void> {
    const index = this.fileIndices.get(filePath);
    if (!index) return;

    for (const conceptId of index.cardKeys.values()) {
      await this.removeConceptWithStudyItems(conceptId, index.deckIds);
    }

    this.fileIndices.delete(filePath);
    await this.persistState();
  }

  /**
   * Ensures deck hierarchy exists for tags like "German/grammar".
   * Creates: German (root) → German/grammar (child).
   * Returns leaf deck IDs (the most specific tag).
   */
  private async ensureDeckHierarchy(tags: string[]): Promise<string[]> {
    const leafDeckIds: string[] = [];

    for (const tag of tags) {
      const parts = tag === VaultSync.UNTAGGED_DECK_TAG
        ? ['Untagged']
        : tag.split('/');
      let parentId: string | null = null;

      for (let i = 0; i < parts.length; i++) {
        const fullTag = tag === VaultSync.UNTAGGED_DECK_TAG
          ? VaultSync.UNTAGGED_DECK_TAG
          : parts.slice(0, i + 1).join('/');

        if (!this.tagToDeckId.has(fullTag)) {
          const deckId = crypto.randomUUID();
          this.tagToDeckId.set(fullTag, deckId);

          await this.container.createDeck.execute({
            id: deckId,
            name: parts[i],
            parentId: null,
          });

          if (parentId) {
            await this.container.nestDeck.execute({
              deckId,
              parentId,
            });
          }
        }

        parentId = this.tagToDeckId.get(fullTag)!;
      }

      // The last segment is the leaf
      leafDeckIds.push(this.tagToDeckId.get(tag)!);
    }

    return leafDeckIds;
  }

  private async createConceptWithStudyItems(
    card: ParsedCard,
  ): Promise<{ conceptId: string; studyItemIds: string[] }> {
    const conceptId = crypto.randomUUID();
    const studyItemIds: string[] = [];

    await this.container.createConcept.execute({
      id: conceptId,
      sideA: card.sideA,
      sideB: card.sideB,
      directionality: card.directionality,
    });

    const atobId = crypto.randomUUID();
    await this.container.createStudyItem.execute({
      id: atobId,
      conceptId,
      direction: Direction.AtoB,
    });
    studyItemIds.push(atobId);

    if (card.directionality === Directionality.Bidirectional) {
      const btoaId = crypto.randomUUID();
      await this.container.createStudyItem.execute({
        id: btoaId,
        conceptId,
        direction: Direction.BtoA,
      });
      studyItemIds.push(btoaId);
    }

    return { conceptId, studyItemIds };
  }

  private async removeConceptWithStudyItems(
    conceptId: string,
    deckIds: string[],
  ): Promise<void> {
    const studyItems = await this.container.studyItemRepository.findByConceptId(
      new ConceptId(conceptId),
    );

    // Remove study items from all associated decks first
    for (const item of studyItems) {
      for (const deckId of deckIds) {
        await this.container.removeStudyItemFromDeck.execute({
          deckId,
          studyItemId: item.id.value,
        });
      }
      await this.container.removeStudyItem.execute({ id: item.id.value });
    }

    await this.container.removeConcept.execute({ id: conceptId });
  }

  /**
   * Stable key based on content. If content changes (typo fix),
   * we detect it as remove+add, losing history. This is acceptable
   * for MVP — a future improvement could use fuzzy matching.
   */
  private cardKey(card: ParsedCard): string {
    // Use JSON.stringify to avoid collisions when content contains the separator
    return JSON.stringify([card.sideA, card.sideB, card.directionality]);
  }

  private sameArrays(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sorted1 = [...a].sort();
    const sorted2 = [...b].sort();
    return sorted1.every((val, idx) => val === sorted2[idx]);
  }

  async beginBatch(): Promise<void> {
    this.batchMode = true;
    this.container.conceptRepository.setBatchMode(true);
    this.container.studyItemRepository.setBatchMode(true);
    this.container.deckRepository.setBatchMode(true);
    this.container.reviewLog.setBatchMode(true);
  }

  async endBatch(): Promise<void> {
    this.batchMode = false;
    // Flush all repos once
    await this.container.conceptRepository.flush();
    await this.container.studyItemRepository.flush();
    await this.container.deckRepository.flush();
    await this.container.reviewLog.flush();
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    if (this.batchMode) return;
    const state: SerializedSyncState = {
      fileIndices: {},
      tagToDeckId: Object.fromEntries(this.tagToDeckId),
    };

    for (const [filePath, index] of this.fileIndices) {
      state.fileIndices[filePath] = {
        cardKeys: Object.fromEntries(index.cardKeys),
        conceptLines: Object.fromEntries(index.conceptLines),
        studyItemIds: index.studyItemIds,
        deckIds: index.deckIds,
      };
    }

    await this.container.syncStateFile.write(state);
  }
}
