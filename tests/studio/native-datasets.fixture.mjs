// Surrounding UI session is synthetic; dataset bytes and measurements come from
// the true-parser/true-algorithm onboarding AC/DC fixture.
import {analysisSession} from './analysis.fixture.mjs';
export function nativeAnalysisSession(base,fixture){
  const value=analysisSession(base,fixture.results.ac);value.job.waveforms=structuredClone(fixture.descriptor);return value;
}
