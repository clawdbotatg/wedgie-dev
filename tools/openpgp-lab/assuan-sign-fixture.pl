#!/usr/bin/env perl
use strict;
use warnings;
use IO::Socket::UNIX;
use Socket qw(SOCK_STREAM);

# Temporary, one-key Assuan fixture. No default GnuPG socket or device access.
my ($frontend, $backend, $keygrip, $agent_version) = @ARGV;
die "fixture paths and keygrip required\n"
    unless defined $agent_version && $agent_version =~ /\A[0-9]+\.[0-9]+\.[0-9]+\z/
        && $keygrip =~ /\A[0-9A-F]{40}\z/
        && $frontend =~ m{\A(/tmp/pgp-bench\.[^/]+)/client/S\.gpg-agent\z}
        && $backend eq "$1/token/S.gpg-agent";
umask 0077;
my $listener = IO::Socket::UNIX->new(Type => SOCK_STREAM, Local => $frontend, Listen => 2)
    or die "fixture listener: $!\n";
my $approved = 1;

sub agent_reply {
    my ($socket) = @_;
    my @data;
    while (my $line = <$socket>) {
        return \@data if $line =~ /\AOK(?: |\r?\n)/;
        return undef if $line =~ /\A(?:ERR |INQUIRE )/;
        if ($line =~ /\AD / && length($line) <= 1002 && @data < 4) {
            push @data, $line;
        } elsif ($line !~ /\A(?:S |#)/) {
            return undef;
        }
    }
    return undef;
}

sub sign_fixture_digest {
    my ($digest) = @_;
    my $token = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $backend) or return;
    $token->autoflush(1);
    agent_reply($token) or return;
    for my $command ("SIGKEY $keygrip", "SETHASH 8 $digest", 'PKSIGN') {
        print {$token} "$command\n" or return;
        my $reply = agent_reply($token) or return;
        return $reply if $command eq 'PKSIGN' && @$reply;
    }
    return;
}

sub serve {
    my ($client) = @_;
    my ($selected, $digest);
    $client->autoflush(1);
    print {$client} "OK P-256 external signing fixture\n";
    while (my $line = <$client>) {
        return if length($line) > 1002;
        $line =~ s/\r?\n\z//;
        my ($verb) = split / /, $line, 2;
        print STDERR "$verb\n" if defined $verb && $verb =~ /\A[A-Z]+\z/;
        my $response = "ERR 67109139 Unsupported fixture request\n";
        if ($line =~ /\AOPTION [ -~]*\z/ || $line =~ /\ASETKEYDESC [ -~]*\z/) {
            $response = "OK\n";
        } elsif ($line eq 'GETINFO version') {
            $response = "D $agent_version\nOK\n";
        } elsif ($line eq 'GETINFO pid') {
            $response = "D $$\nOK\n";
        } elsif ($line eq "HAVEKEY $keygrip") {
            $response = "OK\n";
        } elsif ($line eq "KEYINFO $keygrip") {
            $response = "S KEYINFO $keygrip D - - - C - - -\nOK\n";
        } elsif (defined $verb && $verb eq 'SIGKEY') {
            $selected = $line eq "SIGKEY $keygrip";
            undef $digest;
            $response = $selected ? "OK\n" : "ERR 67108881 Unknown keygrip\n";
        } elsif (defined $verb && $verb eq 'SETHASH') {
            undef $digest;
            if ($selected && $line =~ /\ASETHASH (?:8|--hash=sha256) ([0-9A-Fa-f]{64})\z/) {
                $digest = $1;
                $response = "OK\n";
            }
        } elsif ($line eq 'PKSIGN') {
            if ($selected && defined $digest && $approved) {
                $approved = 0;
                my $reply = sign_fixture_digest($digest);
                if ($reply) {
                    $response = join('', @$reply) . "OK\n";
                    print STDERR "AUTHORIZED_P256_SIGNATURE\n";
                }
            } else {
                $response = "ERR 67108963 Fixture approval unavailable\n";
            }
            undef $selected;
            undef $digest;
        } elsif ($line eq 'RESET') {
            undef $selected;
            undef $digest;
            $response = "OK\n";
        } elsif ($line eq 'BYE') {
            print {$client} "OK closing fixture\n";
            return;
        }
        print {$client} $response or return;
    }
}

# Only the isolated client speaks to this mode-0700 test directory.
$SIG{PIPE} = 'IGNORE';
while (my $client = $listener->accept()) {
    serve($client);
    close $client;
}
