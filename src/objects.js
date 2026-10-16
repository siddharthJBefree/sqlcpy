'use strict';

// Order matters: it is the display order and the order a full copy has to follow (types and sequences before the tables using them).
const KINDS = ['types', 'sequences', 'tables', 'views', 'procedures', 'functions', 'triggers'];
const LABELS = { types: 'Types', sequences: 'Sequences', tables: 'Tables', views: 'Views', procedures: 'Stored procedures', functions: 'Functions', triggers: 'Triggers' };

module.exports = { KINDS, LABELS };
