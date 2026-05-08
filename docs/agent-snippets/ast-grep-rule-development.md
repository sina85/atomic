<!-- AST_GREP_RULE_START -->
## Rule Development Process
1. Break down the user's query into smaller parts.
2. Identify sub rules that can be used to match the code.
3. Combine the sub rules into a single rule using relational rules or composite rules.
4. If rule does not match example code, revise the rule by removing some sub rules and debugging unmatching parts.
5. Use ast-grep mcp tool to dump AST or dump pattern query.
6. Use ast-grep mcp tool to test the rule against the example code snippet.
<!-- AST_GREP_RULE_END -->
