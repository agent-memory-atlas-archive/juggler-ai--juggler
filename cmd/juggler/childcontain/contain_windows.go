//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package childcontain

import (
	"fmt"
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

// prepare is a no-op on Windows; containment is applied post-Start by adopt.
func prepare(_ *exec.Cmd) {}

// adopt creates a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// and assigns the child process to it. When the last handle to the job closes
// — whether because Juggler exited normally, was killed, or crashed — the OS
// terminates all processes in the job, including descendants.
//
// The returned cleanup func closes the job handle. Call it once the child has
// exited; if called while the child is still running the kill-on-close policy
// terminates it immediately.
func adopt(cmd *exec.Cmd) (func(), error) {
	if cmd.Process == nil {
		return func() {}, fmt.Errorf("childcontain: Adopt called before cmd.Start()")
	}

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return func() {}, fmt.Errorf("childcontain: CreateJobObject: %w", err)
	}
	closeJob := func() { _ = windows.CloseHandle(job) }

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		closeJob()
		return func() {}, fmt.Errorf("childcontain: SetInformationJobObject: %w", err)
	}

	ph, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		closeJob()
		return func() {}, fmt.Errorf("childcontain: OpenProcess: %w", err)
	}
	defer func() { _ = windows.CloseHandle(ph) }()

	if err := windows.AssignProcessToJobObject(job, ph); err != nil {
		closeJob()
		return func() {}, fmt.Errorf("childcontain: AssignProcessToJobObject: %w", err)
	}

	return closeJob, nil
}

func terminate(_ *exec.Cmd, child *Child) error {
	// Closing the kill-on-close job handle terminates the full job tree. Route
	// through Cleanup, which closes the handle exactly once however many
	// callers race to terminate the same child.
	child.Cleanup()
	return nil
}
