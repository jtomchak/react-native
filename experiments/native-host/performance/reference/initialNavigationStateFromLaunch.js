import RNTesterList from './RNTesterList';
import {RNTesterNavigationActionsType, RNTesterNavigationReducer} from './RNTesterNavigationReducer';
import {initialNavigationState} from './testerStateUtils';

// The native iOS/Android hosts already pass this URI as an initial property.
// Resolve synchronously so startup never first mounts the Components menu.
export function getInitialStateFromLaunchRoute(route) {
  if (route == null) return initialNavigationState;
  const match = /^rntester(-legacy)?:\/\/example\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?$/.exec(route);
  if (!match) throw new Error(`Invalid RNTester initial route: ${route}`);
  const raw = match[2];
  const keys = [raw, `${raw}Index`, `${raw}Example`].filter(key => RNTesterList.Modules[key] != null);
  if (keys.length !== 1) throw new Error(`Unknown or ambiguous RNTester initial module: ${raw}`);
  const key = keys[0];
  const module = RNTesterList.Modules[key];
  const exampleKey = match[3] || null;
  if (exampleKey != null && module.examples.filter(example => example.name === exampleKey).length !== 1) {
    throw new Error(`Unknown or ambiguous RNTester initial example: ${exampleKey}`);
  }
  return RNTesterNavigationReducer(initialNavigationState, {
    type: RNTesterNavigationActionsType.EXAMPLE_OPEN_URL_REQUEST,
    data: {key, title: module.title || key, exampleKey},
  });
}
