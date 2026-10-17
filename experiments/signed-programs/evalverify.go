package arkade

import (
	"fmt"

	"github.com/btcsuite/btcd/txscript/v2"
)

// Register after the opcode table is initialized: the child engine itself
// executes that table, so a direct initializer reference would be cyclic in Go.
func init() { opcodeArray[OP_EVALVERIFY].opfunc = opcodeEvalVerify }

// opcodeEvalVerify consumes [...arguments, program], executes program with the
// arguments as its data stack and requires exactly one truthy result. Success
// leaves the parent's data stack empty. The caller can then push its own result.
// This research opcode is deliberately unavailable without an explicit option.
func opcodeEvalVerify(op *opcode, data []byte, vm *Engine) error {
	if !vm.experimentalEvalVerify {
		return opcodeInvalid(op, data, vm)
	}
	if vm.evalInvoked {
		return fmt.Errorf("EVALVERIFY: only one invocation per input; no nested evaluation")
	}
	if vm.astack.Depth() != 0 {
		return fmt.Errorf("EVALVERIFY: parent altstack must be empty")
	}
	program, err := vm.dstack.PopByteArray()
	if err != nil {
		return err
	}
	if len(program) == 0 || len(program) > txscript.MaxScriptSize {
		return fmt.Errorf("EVALVERIFY: program size must be 1..%d", txscript.MaxScriptSize)
	}
	tokenizer := MakeScriptTokenizer(0, program)
	for tokenizer.Next() {
		// No code-separator coordinate system is introduced for child code.
		// Reject these even in skipped branches; bytes inside data pushes are data.
		if tokenizer.Opcode() == OP_CODESEPARATOR || tokenizer.Opcode() == OP_EVALVERIFY {
			return fmt.Errorf("EVALVERIFY: nested evaluation and CODESEPARATOR are forbidden")
		}
	}
	if err := tokenizer.Err(); err != nil {
		return err
	}
	if vm.dstack.Depth() > txscript.MaxStackSize || stackByteSize(&vm.dstack) > maxCombinedStackByteSize {
		return fmt.Errorf("EVALVERIFY: argument stack exceeds limits")
	}
	for _, arg := range vm.GetStack() {
		if len(arg) > txscript.MaxScriptElementSize {
			return fmt.Errorf("EVALVERIFY: argument exceeds element limit")
		}
	}

	vm.evalInvoked = true
	// Copy the execution state, preserving the exact transaction, input index,
	// prevout fetcher, asset/emulator packets, clock, expiry, intent message and
	// Bitcoin spending tapleaf. Signature counters and request budgets stay shared
	// by pointer, so the child cannot replenish either budget.
	child := *vm
	child.scripts = [][]byte{program}
	child.scriptIdx, child.opcodeIdx = 0, 0
	child.tokenizer = MakeScriptTokenizer(0, program)
	child.condStack = nil
	child.dstack = stack{verifyMinimalData: true}
	child.astack = stack{verifyMinimalData: true}
	child.SetStack(copyStack(vm.GetStack()))
	if err := child.Execute(); err != nil {
		return fmt.Errorf("EVALVERIFY: child failed: %w", err)
	}
	vm.SetStack(nil)
	return nil
}
