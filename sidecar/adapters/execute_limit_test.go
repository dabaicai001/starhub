package adapters

import "testing"

func TestClampExecuteMaxRows(t *testing.T) {
	cases := []struct {
		name     string
		input    int
		expected int
	}{
		{name: "unset falls back to default", input: 0, expected: DefaultExecuteMaxRows},
		{name: "negative falls back to default", input: -5, expected: DefaultExecuteMaxRows},
		{name: "positive passes through", input: 500, expected: 500},
		{name: "exact default passes through", input: DefaultExecuteMaxRows, expected: DefaultExecuteMaxRows},
		{name: "above hard cap is clamped", input: MaxExecuteMaxRows + 1, expected: MaxExecuteMaxRows},
		{name: "exact hard cap passes through", input: MaxExecuteMaxRows, expected: MaxExecuteMaxRows},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClampExecuteMaxRows(tc.input); got != tc.expected {
				t.Fatalf("ClampExecuteMaxRows(%d) = %d, want %d", tc.input, got, tc.expected)
			}
		})
	}
}
