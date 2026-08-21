-- Normalisation and ISO 6346.
do $$
begin
  -- Safe normalisation: case and separators only.
  perform tst.eq(app.normalize_code(' msku 451234-0 '), 'MSKU4512340', 'normalise strips and folds');
  perform tst.eq(app.normalize_code('mat752389t7r19810'), 'MAT752389T7R19810', 'chassis normalises');
  perform tst.eq(app.normalize_code('   '), null, 'blank normalises to null');

  -- It must NOT map confusable characters: doing so could make two genuinely
  -- different identifiers compare equal and mask a real mismatch.
  perform tst.ok(app.normalize_code('MATO123') <> app.normalize_code('MAT0123'),
                 'normalisation must not fold O to 0');

  -- ISO 6346 check digit. CSQU3054383 is the published worked example.
  perform tst.ok(app.is_valid_container_no('CSQU3054383'), 'CSQU3054383 is valid');
  perform tst.eq(app.container_check_digit('MSKU451234'), 0, 'MSKU451234 check digit is 0');
  perform tst.ok(app.is_valid_container_no('MSKU4512340'), 'MSKU4512340 is valid');
  perform tst.ok(not app.is_valid_container_no('MSKU4512345'), 'MSKU4512345 is NOT valid');

  -- Every single-digit mutation of a valid number must be rejected. This is
  -- the property that makes the check digit worth running in the camera loop.
  for i in 5..11 loop
    declare
      base text := 'CSQU3054383';
      mutated text;
      d int;
    begin
      d := substr(base, i, 1)::int;
      mutated := overlay(base placing ((d + 1) % 10)::text from i for 1);
      perform tst.ok(not app.is_valid_container_no(mutated),
                     format('mutation at position %s (%s) must be rejected', i, mutated));
    end;
  end loop;

  -- Non-ISO identifiers: shaped-ness is detected so check digits are not
  -- demanded of references that never carried one.
  perform tst.ok(not app.is_iso6346_shaped('CULVNSA2601795'), 'CULVNSA2601795 is not ISO shaped');
  perform tst.ok(app.is_iso6346_shaped('CSQU3054383'), 'CSQU3054383 is ISO shaped');
end $$;
