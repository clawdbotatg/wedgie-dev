#!/usr/bin/env perl
use strict;
use warnings;
use IO::Socket::UNIX;
use JSON::PP qw(encode_json decode_json);
use Socket qw(SOCK_STREAM);
use Time::HiRes qw(sleep);

my ($socket_path) = @ARGV;
die "Expected a disposable fixture socket\n" unless $socket_path =~ m{\A/tmp/pgp-virtual\.[^/]+/S\.gpg-agent\z};
umask 0077;
my $listener = IO::Socket::UNIX->new(Type => SOCK_STREAM, Local => $socket_path, Listen => 2)
    or die "Fixture socket: $!\n";
my ($point, $grip);
my $signatures = 0;

sub request_token {
    my ($request) = @_;
    open my $output, '>:raw', '/mailbox/request.tmp' or die "Request file: $!\n";
    print {$output} encode_json($request);
    close $output or die "Request close: $!\n";
    rename '/mailbox/request.tmp', '/mailbox/request' or die "Request ready: $!\n";
    for (1..1200) {
        if (open my $input, '<:raw', '/mailbox/reply') {
            local $/;
            my $reply = decode_json(<$input>);
            close $input;
            unlink '/mailbox/reply' or die "Reply cleanup: $!\n";
            return $reply;
        }
        sleep(0.05);
    }
    die "Virtual token did not respond\n";
}

sub assuan_data {
    my ($data) = @_;
    $data =~ s/([\x00-\x1f\x7f-\xff%])/sprintf('%%%02X', ord($1))/ge;
    return "D $data\nOK\n";
}

sub mpi {
    my ($octets) = @_;
    $octets =~ s/\A\x00+//;
    $octets = "\x00" . $octets if length($octets) && ord(substr($octets, 0, 1)) & 0x80;
    return length($octets) . ':' . $octets;
}

sub serve {
    my ($client) = @_;
    my ($selected, $digest);
    $client->autoflush(1);
    print {$client} "OK Virtual OpenPGP test fixture\n";
    while (my $line = <$client>) {
        return if length($line) > 1002;
        $line =~ s/\r?\n\z//;
        my $response = "ERR 67109139 Unsupported fixture request\n";
        if ($line eq 'GETINFO version') {
            $response = "D 2.2.40\nOK\n";
        } elsif ($line eq 'GETINFO pid') {
            $response = "D $$\nOK\n";
        } elsif ($line =~ /\A(?:OPTION|SETKEYDESC) [ -~]*\z/) {
            $response = "OK\n";
        } elsif (!defined $point && $line =~ /\AGENKEY --timestamp=[0-9]{8}T[0-9]{6}\z/) {
            print {$client} "INQUIRE KEYPARAM\n";
            my $parameters = <$client> // '';
            my $end = <$client> // '';
            if (length($parameters) <= 1024 && $parameters =~ /\AD .*NIST P-256/ && $end eq "END\n") {
                my $reply = request_token({type => 'pgp_key'});
                die "Virtual P-256 key missing\n" unless $reply->{type} eq 'pgp_key' && $reply->{public} =~ /\A04[0-9a-f]{128}\z/;
                $point = pack('H*', $reply->{public});
                $response = assuan_data('(10:public-key(3:ecc(5:curve10:NIST P-256)(1:q65:' . $point . ')))');
            }
        } elsif (defined $grip && $line eq "HAVEKEY $grip") {
            $response = "OK\n";
        } elsif (defined $grip && $line eq "KEYINFO $grip") {
            $response = "S KEYINFO $grip D - - - C - - -\nOK\n";
        } elsif ($line =~ /\ASIGKEY (.*)\z/) {
            my $requested = $1;
            # The first call belongs to the only isolated GnuPG client, which derived it from GENKEY.
            $grip = $requested if defined $point && !defined $grip && $requested =~ /\A[0-9A-F]{40}\z/;
            $selected = defined $grip && $requested eq $grip;
            undef $digest;
            $response = $selected ? "OK\n" : "ERR 67108881 Unknown fixture keygrip\n";
        } elsif ($line =~ /\ASETHASH /) {
            undef $digest;
            if ($selected && $line =~ /\ASETHASH 8 ([0-9A-Fa-f]{64})\z/) {
                $digest = $1;
                $response = "OK\n";
            }
        } elsif ($line =~ /\APKSIGN(?: -- [0-9A-F]+)?\z/) {
            if ($selected && defined $digest && $signatures < 3) {
                my $reply = request_token({type => 'pgp_sign', digest => $digest});
                die "Virtual P-256 signature missing\n" unless $reply->{type} eq 'pgp_sig'
                    && $reply->{signature} =~ /\A([0-9a-f]{64})([0-9a-f]{64})\z/;
                my ($r_hex, $s_hex) = ($1, $2);
                my ($r, $s) = (mpi(pack('H*', $r_hex)), mpi(pack('H*', $s_hex)));
                $signatures++;
                $response = assuan_data('(7:sig-val(5:ecdsa(1:r' . $r . ')(1:s' . $s . ')))');
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

$SIG{PIPE} = 'IGNORE';
while (my $client = $listener->accept()) {
    serve($client);
    close $client;
}
