import { DeckRepository } from '../domain/deck-repository';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { DeckId } from '../domain/deck-id';

export interface DeckTreeNode {
  id: string;
  name: string;
  totalItems: number;
  dueItems: number;
  children: DeckTreeNode[];
}

export class GetDeckTree {
  constructor(
    private readonly deckRepository: DeckRepository,
    private readonly studyItemRepository: StudyItemRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<DeckTreeNode[]> {
    const roots = await this.deckRepository.findRoots();
    const dueItems = await this.studyItemRepository.findDue(now);
    const dueIds = new Set(dueItems.map(item => item.id.value));

    const nodes: DeckTreeNode[] = [];
    for (const root of roots) {
      nodes.push(await this.buildNode(root.id, root.name, root.studyItemIds.map(si => si.value), dueIds));
    }
    return nodes;
  }

  private async buildNode(
    deckId: DeckId,
    name: string,
    studyItemIdValues: string[],
    dueIds: Set<string>,
  ): Promise<DeckTreeNode> {
    const children = await this.deckRepository.findByParentId(deckId);
    const childNodes: DeckTreeNode[] = [];

    let totalItems = studyItemIdValues.length;
    let dueItems = studyItemIdValues.filter(id => dueIds.has(id)).length;

    for (const child of children) {
      const childNode = await this.buildNode(
        child.id,
        child.name,
        child.studyItemIds.map(si => si.value),
        dueIds,
      );
      childNodes.push(childNode);
      totalItems += childNode.totalItems;
      dueItems += childNode.dueItems;
    }

    return {
      id: deckId.value,
      name,
      totalItems,
      dueItems,
      children: childNodes,
    };
  }
}
