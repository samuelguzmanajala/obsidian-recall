import { MarkdownParser, ParsedCard } from '@context/concept/infrastructure/markdown-parser';
import { FrontmatterParser } from '@context/concept/infrastructure/frontmatter-parser';
import { Directionality } from '@context/concept/domain/directionality';
import { Direction } from '@context/study/domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';
import { DeckId } from '@context/deck/domain/deck-id';
import { JsonFileStorage, SerializedSyncState } from '@context/shared/infrastructure/json-storage';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { CreateConcept } from '@context/concept/application/create-concept';
import { RemoveConcept } from '@context/concept/application/remove-concept';
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { RemoveStudyItem } from '@context/study/application/remove-study-item';
import { CreateDeck } from '@context/deck/application/create-deck';
import { NestDeck } from '@context/deck/application/nest-deck';
import { AddStudyItemToDeck } from '@context/deck/application/add-study-item-to-deck';
import { RemoveStudyItemFromDeck } from '@context/deck/application/remove-study-item-from-deck';

/** Everything the indexer needs; the composition root wires it. */
export interface NoteIndexerDeps {
  parser: Pick<MarkdownParser, 'parse'>;
  /** Persisted index (file → cards, tag → deck). Its format is stored by existing databases. */
  syncState: JsonFileStorage;
  studyItemRepository: Pick<StudyItemRepository, 'findByConceptId'>;
  deckRepository: Pick<DeckRepository, 'findById'>;
  createConcept: Pick<CreateConcept, 'execute'>;
  removeConcept: Pick<RemoveConcept, 'execute'>;
  createStudyItem: Pick<CreateStudyItem, 'execute'>;
  removeStudyItem: Pick<RemoveStudyItem, 'execute'>;
  createDeck: Pick<CreateDeck, 'execute'>;
  nestDeck: Pick<NestDeck, 'execute'>;
  addStudyItemToDeck: Pick<AddStudyItemToDeck, 'execute'>;
  removeStudyItemFromDeck: Pick<RemoveStudyItemFromDeck, 'execute'>;
  /** Tags to index. Only notes with at least one matching tag (or subtag) are indexed. Empty = all. */
  allowedTags?: string[];
}

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

/**
 * Translates Markdown notes into concept, study item and deck commands, and remembers
 * which cards came from which note. Card, concept and deck IDs are derived from content.
 */
export class NoteIndexer {
  private fileIndices = new Map<string, FileIndex>();
  private frontmatterParser = new FrontmatterParser();
  /** tag → deckId — ensures same tag always maps to same deck */
  private tagToDeckId = new Map<string, string>();

  private static readonly UNTAGGED_DECK_TAG = '__untagged__';

  /** Tags the user configured. Empty = allow all. */
  private readonly allowedTags: string[];

  constructor(private readonly deps: NoteIndexerDeps) {
    this.allowedTags = deps.allowedTags ?? [];
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
    const state = await this.deps.syncState.read<SerializedSyncState>();
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
    const parsedCards = this.deps.parser.parse(content, filePath);
    const tags = this.frontmatterParser.extractTags(content);
    const previousIndex = this.fileIndices.get(filePath);

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

    const newIndex: FileIndex = { cardKeys: new Map(), conceptLines: new Map(), studyItemIds: [], deckIds: [] };

    const previousKeys = new Set(previousIndex?.cardKeys.keys() ?? []);

    // Filter tags to only those matching the allowed filter
    // Files without matching tags go to "Untagged" deck
    const filteredTags = this.filterToAllowedTags(tags);
    const effectiveTags = filteredTags.length > 0 ? filteredTags : [NoteIndexer.UNTAGGED_DECK_TAG];
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
          const studyItems = await this.deps.studyItemRepository.findByConceptId(
            new ConceptId(conceptId),
          );
          const siIds = studyItems.map(si => si.id.value);

          // Remove from old decks
          const retainedDecks = new Set([...this.fileIndices.entries()]
            .filter(([path, index]) => path !== filePath && [...index.cardKeys.values()].includes(conceptId))
            .flatMap(([, index]) => index.deckIds));
          for (const oldDeckId of previousIndex!.deckIds) {
            if (retainedDecks.has(oldDeckId)) continue;
            for (const siId of siIds) {
              await this.deps.removeStudyItemFromDeck.execute({
                deckId: oldDeckId,
                studyItemId: siId,
              });
            }
          }

          // Add to new decks
          for (const deckId of leafDeckIds) {
            for (const siId of siIds) {
              await this.deps.addStudyItemToDeck.execute({
                deckId,
                studyItemId: siId,
              });
            }
          }

          newIndex.studyItemIds.push(...siIds);
        } else {
          // Decks didn't change — carry over studyItemIds
          const studyItems = await this.deps.studyItemRepository.findByConceptId(
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
            await this.deps.addStudyItemToDeck.execute({
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
      await this.removeConceptWithStudyItems(conceptId, previousIndex!.deckIds, filePath);
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
      await this.removeConceptWithStudyItems(conceptId, index.deckIds, filePath);
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
      const parts = tag === NoteIndexer.UNTAGGED_DECK_TAG
        ? ['Untagged']
        : tag.split('/');
      let parentId: string | null = null;

      for (let i = 0; i < parts.length; i++) {
        const fullTag = tag === NoteIndexer.UNTAGGED_DECK_TAG
          ? NoteIndexer.UNTAGGED_DECK_TAG
          : parts.slice(0, i + 1).join('/');

        let deckId = this.tagToDeckId.get(fullTag);
        if (!deckId) {
          deckId = await this.computeDeterministicId(`deck:${fullTag}`);
          this.tagToDeckId.set(fullTag, deckId);
        }

        const existingDeck = await this.deps.deckRepository.findById(new DeckId(deckId));
        if (!existingDeck) {
          await this.deps.createDeck.execute({
            id: deckId,
            name: parts[i],
            parentId,
          });
        } else if (parentId && existingDeck.parentId?.value !== parentId) {
          await this.deps.nestDeck.execute({
            deckId,
            parentId,
          });
        }

        parentId = deckId;
      }

      // The last segment is the leaf
      leafDeckIds.push(this.tagToDeckId.get(tag)!);
    }

    return leafDeckIds;
  }

  private async createConceptWithStudyItems(
    card: ParsedCard,
  ): Promise<{ conceptId: string; studyItemIds: string[] }> {
    // Deterministic IDs based on content — same card always gets same ID
    // This makes reviews survive rebuild (IDs don't change)
    const conceptId = await this.computeDeterministicId(`concept:${card.sideA}|${card.sideB}|${card.directionality}`);
    const studyItemIds: string[] = [];

    await this.deps.createConcept.execute({
      id: conceptId,
      sideA: card.sideA,
      sideB: card.sideB,
      directionality: card.directionality,
    });

    const atobId = await this.computeDeterministicId(`si:${card.sideA}|${card.sideB}|a-to-b`);
    await this.deps.createStudyItem.execute({
      id: atobId,
      conceptId,
      direction: Direction.AtoB,
    });
    studyItemIds.push(atobId);

    if (card.directionality === Directionality.Bidirectional) {
      const btoaId = await this.computeDeterministicId(`si:${card.sideA}|${card.sideB}|b-to-a`);
      await this.deps.createStudyItem.execute({
        id: btoaId,
        conceptId,
        direction: Direction.BtoA,
      });
      studyItemIds.push(btoaId);
    }

    return { conceptId, studyItemIds };
  }

  /**
   * Generate a deterministic UUID-like ID from a string.
   * Same input always produces the same output.
   * Uses SHA-256 truncated to UUID format.
   */
  async computeDeterministicId(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    // Format as UUID v4-like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private async removeConceptWithStudyItems(
    conceptId: string,
    deckIds: string[],
    excludingPath: string,
  ): Promise<void> {
    const otherSources = [...this.fileIndices.entries()]
      .filter(([path, index]) => path !== excludingPath && [...index.cardKeys.values()].includes(conceptId));
    const retainedDecks = new Set(otherSources.flatMap(([, index]) => index.deckIds));
    const studyItems = await this.deps.studyItemRepository.findByConceptId(
      new ConceptId(conceptId),
    );

    // Remove study items from all associated decks first
    for (const item of studyItems) {
      for (const deckId of deckIds) {
        if (retainedDecks.has(deckId)) continue;
        await this.deps.removeStudyItemFromDeck.execute({
          deckId,
          studyItemId: item.id.value,
        });
      }
      if (otherSources.length === 0) await this.deps.removeStudyItem.execute({ id: item.id.value });
    }

    if (otherSources.length === 0) await this.deps.removeConcept.execute({ id: conceptId });
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

  private async persistState(): Promise<void> {
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

    await this.deps.syncState.write(state);
  }
}
