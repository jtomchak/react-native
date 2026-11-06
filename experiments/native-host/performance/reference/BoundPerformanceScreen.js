import * as React from 'react';
import {View, Text, Image, Pressable, TextInput, ScrollView} from 'react-native';
import {createPerformanceScreen} from './workload';

// Keep the stateful factory result in a module that does not import revision.
// Updating a revision must not create a new unregistered nested component type.
const PerformanceScreen = createPerformanceScreen(React, {View, Text, Image, Pressable, TextInput, ScrollView});
export default PerformanceScreen;
