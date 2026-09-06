import type { Container } from './container';

/** UI port. Both the legacy local adapter and HTTP client implement it. */
export interface StudyClient {
  remote?: boolean;
  settings: Container['settings'];
  saveSettingsQuiet: Container['saveSettingsQuiet'];
  getDueStudyItems: Pick<Container['getDueStudyItems'], 'execute'>;
  getDueStudyItemsByDeck: Pick<Container['getDueStudyItemsByDeck'], 'execute'>;
  getDeckTree: Pick<Container['getDeckTree'], 'execute'>;
  getStudyStats: Pick<Container['getStudyStats'], 'execute'>;
  getLeeches: Pick<Container['getLeeches'], 'execute'>;
  reviewStudyItem: Pick<Container['reviewStudyItem'], 'execute'>;
  scheduler?: Container['scheduler'];
  studyItemRepository: Pick<Container['studyItemRepository'], 'findById'>;
  conceptRepository: Pick<Container['conceptRepository'], 'findById'>;
  vaultSync: Pick<NonNullable<Container['vaultSync']>, 'findFileByConceptId'> | null;
}
